import type { Database } from "bun:sqlite";
import path from "path";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { runFfmpegFrameExtract } from "../../fs/disk-writes";
import { getDiskById } from "../../disks/registry";
import { ensureFrameRowsForSet } from "./encoding-frames";

/**
 * Extracts evenly-spaced JPEG frames from each sample's source clip and from
 * every variant of that sample whose encode finished successfully. Frames are
 * the input to the comparison UI's blind-test grid; per-frame status lives in
 * `encoding_frames`.
 *
 * Layout under the set's scratch root:
 *
 *   <scratch>/set-<set>/sample-<smp>/source/frame-<pos>.jpg
 *   <scratch>/set-<set>/sample-<smp>/variant-<vid>/frame-<pos>.jpg
 *
 * The `frame-N.jpg` basename is required by `disk-writes.deleteEncodingScratchFile`
 * so the scratch-cleanup endpoint can later unlink them.
 *
 * Source-frame timestamps are derived once per sample:
 *
 *   start    = clip_start_seconds (or 0)
 *   duration = clip_duration_seconds (or source_duration_seconds)
 *   t_i      = start + ((i + 0.5) / framesPerVariant) * duration
 *
 * A sample whose source duration is unknown and that has no clip window is
 * skipped with a warning event — the comparison can still proceed for the
 * other samples in the set.
 *
 * The job is restart-safe: only frame rows whose `output_path IS NULL` are
 * picked up, regardless of their `status`. That means a scratch-cleanup that
 * unlinks frame files + nulls `output_path` makes the row eligible for
 * re-extraction the next time the job runs.
 */
export class EncodingFrameExtractJobRunner extends JobRunner {
  private db: Database;
  private setId: number;
  private framesPerVariant: number;
  private concurrency: number;
  private set: { id: number; name: string; scratch_root: string } | null = null;
  private progress: {
    setId: number;
    framesTotal: number;
    framesCompleted: number;
    framesFailed: number;
    framesRunning: number;
    samplesSkipped: number;
  };

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    setId: number;
    framesPerVariant?: number;
    concurrency?: number;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.setId = opts.setId;
    this.framesPerVariant = Math.max(1, Math.min(20, opts.framesPerVariant ?? 5));
    this.concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
    this.progress = {
      setId: this.setId,
      framesTotal: 0,
      framesCompleted: 0,
      framesFailed: 0,
      framesRunning: 0,
      samplesSkipped: 0,
    };
  }

  protected async execute(): Promise<void> {
    const set = this.db
      .prepare(`SELECT id, name, scratch_root FROM encoding_sample_sets WHERE id = ?`)
      .get(this.setId) as { id: number; name: string; scratch_root: string } | null;
    if (!set) throw new Error(`encoding sample set ${this.setId} not found`);
    this.set = set;

    this.ensureFrameRows();

    const work = this.loadPendingFrames();
    this.progress.framesTotal = work.length;
    this.broadcast();

    if (work.length === 0) {
      this.logEvent("info", "no_work", "No frames need extraction — all already present.");
      return;
    }

    this.logEvent(
      "info",
      "progress_milestone",
      `Extracting ${work.length} frame${work.length === 1 ? "" : "s"} at concurrency ${this.concurrency}`
    );

    const queue = [...work];
    const running = new Set<Promise<void>>();

    while (queue.length > 0 || running.size > 0) {
      await this.checkPause();

      while (running.size < this.concurrency && queue.length > 0) {
        const item = queue.shift()!;
        this.progress.framesRunning += 1;
        this.broadcast();
        const p = this.runOne(item).finally(() => {
          this.progress.framesRunning -= 1;
          this.broadcast();
          running.delete(p);
        });
        running.add(p);
      }
      if (running.size > 0) {
        await Promise.race(running);
      }
    }

    this.logEvent(
      "info",
      "progress_milestone",
      `Extracted ${this.progress.framesCompleted} frame${this.progress.framesCompleted === 1 ? "" : "s"} ` +
        `(${this.progress.framesFailed} failed, ${this.progress.samplesSkipped} sample(s) skipped).`
    );
  }

  private ensureFrameRows(): void {
    const result = ensureFrameRowsForSet(this.db, this.setId, this.framesPerVariant);
    this.progress.samplesSkipped = result.samplesSkipped.length;
    for (const skipped of result.samplesSkipped) {
      this.logEvent(
        "warning",
        "sample_skipped",
        `sample ${skipped.sampleId}: no clip duration and no source_duration_seconds — cannot place frames`
      );
    }
  }

  private loadPendingFrames(): FrameWork[] {
    const rows = this.db
      .prepare(
        `SELECT f.id          AS frame_id,
                f.sample_id   AS f_sample_id,
                f.variant_id  AS f_variant_id,
                f.position    AS f_position,
                f.at_seconds  AS f_at_seconds,
                s.id          AS s_id,
                s.source_disk_id,
                s.source_path,
                v.output_path AS v_output_path
           FROM encoding_frames f
           LEFT JOIN encoding_variants v
             ON v.id = f.variant_id
           LEFT JOIN encoding_samples s
             ON s.id = COALESCE(f.sample_id, v.sample_id)
          WHERE s.set_id = ?
            AND f.output_path IS NULL
          ORDER BY s.position, f.variant_id IS NULL DESC, f.variant_id, f.position`
      )
      .all(this.setId) as Array<{
        frame_id: number;
        f_sample_id: number | null;
        f_variant_id: number | null;
        f_position: number;
        f_at_seconds: number;
        s_id: number;
        source_disk_id: number;
        source_path: string;
        v_output_path: string | null;
      }>;

    const out: FrameWork[] = [];
    for (const r of rows) {
      // For source frames we read from the original disk; for variant frames
      // we read from the variant's encoded output in the scratch root.
      let sourcePath: string;
      let sourceMountPath: string;
      if (r.f_variant_id !== null) {
        if (!r.v_output_path) {
          // Variant has no output_path yet — skip silently; the encoder job
          // is the canonical place to surface that failure.
          continue;
        }
        sourcePath = r.v_output_path;
        sourceMountPath = this.set!.scratch_root;
      } else {
        const disk = getDiskById(this.db, r.source_disk_id);
        if (!disk || !disk.mount_path) {
          throw new Error(
            `frame ${r.frame_id}: source disk ${r.source_disk_id} is not mounted`
          );
        }
        sourcePath = r.source_path;
        sourceMountPath = disk.mount_path;
      }

      out.push({
        frameId: r.frame_id,
        sampleId: r.s_id,
        variantId: r.f_variant_id,
        position: r.f_position,
        atSeconds: r.f_at_seconds,
        sourcePath,
        sourceMountPath,
      });
    }
    return out;
  }

  private async runOne(item: FrameWork): Promise<void> {
    if (!this.set) throw new Error("invariant: set not loaded");
    const outputPath = this.outputPathFor(item);

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE encoding_frames
            SET status = 'running', started_at = ?
          WHERE id = ?`
      )
      .run(now, item.frameId);

    let exitCode = -1;
    let stderr = "";
    let runError: string | null = null;

    try {
      const r = await runFfmpegFrameExtract({
        sourcePath: item.sourcePath,
        sourceMountPath: item.sourceMountPath,
        outputPath,
        outputRootPath: this.set.scratch_root,
        atSeconds: item.atSeconds,
        signal: this.abortController.signal,
      });
      exitCode = r.exitCode;
      stderr = r.stderr;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }

    const success = runError === null && exitCode === 0;
    const completedAt = new Date().toISOString();
    const stderrTail = stderr.slice(-2000);

    this.db
      .prepare(
        `UPDATE encoding_frames
            SET status = ?,
                output_path = ?,
                error_detail = ?,
                completed_at = ?
          WHERE id = ?`
      )
      .run(
        success ? "done" : "failed",
        success ? outputPath : null,
        success ? null : runError ?? `ffmpeg exit ${exitCode}: ${stderrTail}`,
        completedAt,
        item.frameId
      );

    if (success) {
      this.progress.framesCompleted += 1;
    } else {
      this.progress.framesFailed += 1;
      this.incrementProgress({ errorsCount: 1 });
      this.logEvent(
        "error",
        "frame_failed",
        `Frame ${item.frameId} (${item.variantId !== null ? `variant ${item.variantId}` : `source sample ${item.sampleId}`} @${item.atSeconds.toFixed(2)}s) failed: ${
          runError ?? `exit ${exitCode}`
        }`,
        { stderrTail }
      );
    }
    this.incrementProgress({ itemsProcessed: 1, progressJson: this.progress });
  }

  private outputPathFor(item: FrameWork): string {
    if (!this.set) throw new Error("invariant: set not loaded");
    const subdir =
      item.variantId !== null ? `variant-${item.variantId}` : "source";
    return path.join(
      this.set.scratch_root,
      `set-${this.setId}`,
      `sample-${item.sampleId}`,
      subdir,
      `frame-${item.position}.jpg`
    );
  }

  private broadcast(): void {
    this.incrementProgress({ progressJson: this.progress });
  }
}

interface FrameWork {
  frameId: number;
  sampleId: number;
  variantId: number | null;
  position: number;
  atSeconds: number;
  sourcePath: string;
  sourceMountPath: string;
}
