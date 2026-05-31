import type { Database } from "bun:sqlite";
import path from "path";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { runFfmpegEncode } from "../../fs/disk-writes";
import { getDiskById } from "../../disks/registry";
import { buildVariantArgs } from "./encoding-args";
import { recordAudit } from "../../lib/audit";

interface VariantRow {
  id: number;
  sample_id: number;
  position: number;
  codec: string;
  encoder: string;
  preset: string | null;
  crf: number | null;
  extra_args_json: string | null;
  status: string;
}

interface SampleRow {
  id: number;
  set_id: number;
  source_disk_id: number;
  source_path: string;
  clip_start_seconds: number | null;
  clip_duration_seconds: number | null;
}

interface SetRow {
  id: number;
  name: string;
  scratch_root: string;
}

interface VariantWork {
  variant: VariantRow;
  sample: SampleRow;
  sourceMountPath: string;
}

interface EncodingProgress {
  setId: number;
  variantsTotal: number;
  variantsCompleted: number;
  variantsFailed: number;
  variantsRunning: number;
  totalEncodeSeconds: number;
  totalOutputBytes: number;
}

/**
 * Runs every pending variant in an encoding sample set. Each variant is
 * encoded by ffmpeg in a subprocess; up to `concurrency` variants run in
 * parallel. Per-variant outcomes (bytes-out, wall-clock seconds, exit code,
 * stderr tail) are persisted to the `encoding_variants` row in real time so
 * the UI can render partial results before the whole sweep is finished.
 *
 * The job is restart-safe: only variants whose `status = 'pending'` (or
 * `'failed'` with an explicit retry — not implemented here yet) are picked
 * up. Already-`done` variants are left alone.
 */
export class EncodingSampleRunJobRunner extends JobRunner {
  private db: Database;
  private setId: number;
  private concurrency: number;
  private set: SetRow | null = null;
  private progress: EncodingProgress;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    setId: number;
    concurrency?: number;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.setId = opts.setId;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.progress = {
      setId: this.setId,
      variantsTotal: 0,
      variantsCompleted: 0,
      variantsFailed: 0,
      variantsRunning: 0,
      totalEncodeSeconds: 0,
      totalOutputBytes: 0,
    };
  }

  protected async execute(): Promise<void> {
    const set = this.db
      .prepare(`SELECT id, name, scratch_root FROM encoding_sample_sets WHERE id = ?`)
      .get(this.setId) as SetRow | null;
    if (!set) {
      throw new Error(`encoding sample set ${this.setId} not found`);
    }
    this.set = set;
    this.db
      .prepare(`UPDATE encoding_sample_sets SET status = 'encoding' WHERE id = ?`)
      .run(this.setId);

    const work = this.loadPendingWork();
    this.progress.variantsTotal = work.length;
    this.broadcast();

    if (work.length === 0) {
      this.logEvent("info", "no_work", "No pending variants — set already encoded.");
      this.markSetReady();
      return;
    }

    this.logEvent(
      "info",
      "progress_milestone",
      `Encoding ${work.length} variant${work.length === 1 ? "" : "s"} at concurrency ${this.concurrency}`
    );

    const queue = [...work];
    const running = new Set<Promise<void>>();

    while (queue.length > 0 || running.size > 0) {
      await this.checkPause();

      while (running.size < this.concurrency && queue.length > 0) {
        const item = queue.shift()!;
        this.progress.variantsRunning += 1;
        this.broadcast();
        const p = this.runOne(item).finally(() => {
          this.progress.variantsRunning -= 1;
          this.broadcast();
          running.delete(p);
        });
        running.add(p);
      }

      if (running.size > 0) {
        await Promise.race(running);
      }
    }

    this.markSetReady();
    this.logEvent(
      "info",
      "progress_milestone",
      `Encoded ${this.progress.variantsCompleted} variant${this.progress.variantsCompleted === 1 ? "" : "s"} ` +
        `(${this.progress.variantsFailed} failed) in ${this.progress.totalEncodeSeconds.toFixed(1)}s total CPU time. ` +
        `Output: ${(this.progress.totalOutputBytes / 1e9).toFixed(2)} GB`
    );
  }

  private loadPendingWork(): VariantWork[] {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.sample_id, v.position, v.codec, v.encoder, v.preset, v.crf,
                v.extra_args_json, v.status,
                s.id AS s_id, s.set_id AS s_set_id,
                s.source_disk_id, s.source_path,
                s.clip_start_seconds, s.clip_duration_seconds
           FROM encoding_variants v
           JOIN encoding_samples s ON s.id = v.sample_id
          WHERE s.set_id = ?
            AND v.status = 'pending'
          ORDER BY s.position, v.position`
      )
      .all(this.setId) as Array<
        VariantRow & {
          s_id: number;
          s_set_id: number;
          source_disk_id: number;
          source_path: string;
          clip_start_seconds: number | null;
          clip_duration_seconds: number | null;
        }
      >;

    const out: VariantWork[] = [];
    for (const r of rows) {
      const disk = getDiskById(this.db, r.source_disk_id);
      if (!disk || !disk.mount_path) {
        throw new Error(
          `encoding sample ${r.s_id}: source disk ${r.source_disk_id} is not mounted`
        );
      }
      out.push({
        variant: {
          id: r.id,
          sample_id: r.sample_id,
          position: r.position,
          codec: r.codec,
          encoder: r.encoder,
          preset: r.preset,
          crf: r.crf,
          extra_args_json: r.extra_args_json,
          status: r.status,
        },
        sample: {
          id: r.s_id,
          set_id: r.s_set_id,
          source_disk_id: r.source_disk_id,
          source_path: r.source_path,
          clip_start_seconds: r.clip_start_seconds,
          clip_duration_seconds: r.clip_duration_seconds,
        },
        sourceMountPath: disk.mount_path,
      });
    }
    return out;
  }

  private async runOne(item: VariantWork): Promise<void> {
    const { variant, sample, sourceMountPath } = item;
    if (!this.set) throw new Error("invariant: set not loaded");
    const extraArgs = variant.extra_args_json
      ? (JSON.parse(variant.extra_args_json) as string[])
      : [];

    const args = buildVariantArgs({
      codec: variant.codec,
      encoder: variant.encoder,
      preset: variant.preset,
      crf: variant.crf,
      extraArgs,
    });

    const outputPath = this.outputPathFor(sample, variant, args.extension);

    // Persist running state up front so external observers see it.
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE encoding_variants SET status = 'running', started_at = ?, output_path = ? WHERE id = ?`
      )
      .run(now, outputPath, variant.id);

    let exitCode = -1;
    let stderr = "";
    let outputBytes = 0;
    let elapsedSeconds = 0;
    let runError: string | null = null;

    try {
      const result = await runFfmpegEncode({
        sourcePath: sample.source_path,
        sourceMountPath,
        outputPath,
        outputRootPath: this.set.scratch_root,
        clipStartSeconds: sample.clip_start_seconds,
        clipDurationSeconds: sample.clip_duration_seconds,
        videoArgs: args.videoArgs,
        containerArgs: args.containerArgs,
        signal: this.abortController.signal,
      });
      exitCode = result.exitCode;
      stderr = result.stderr;
      outputBytes = result.outputBytes;
      elapsedSeconds = result.elapsedSeconds;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }

    const success = runError === null && exitCode === 0 && outputBytes > 0;
    const completedAt = new Date().toISOString();
    // Keep stderr small — tail it so the row stays manageable on disk.
    const stderrTail = stderr.slice(-4000);

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE encoding_variants
              SET status = ?,
                  output_size_bytes = ?,
                  encode_seconds = ?,
                  error_detail = ?,
                  completed_at = ?
            WHERE id = ?`
        )
        .run(
          success ? "done" : "failed",
          success ? outputBytes : null,
          elapsedSeconds || null,
          success ? null : runError ?? `ffmpeg exit ${exitCode}: ${stderrTail}`,
          completedAt,
          variant.id
        );

      recordAudit(this.db, {
        action: success ? "encoding_variant_encode" : "encoding_variant_encode_failed",
        actor: "system",
        targetKind: "encoding_variant",
        targetId: variant.id,
        after: success
          ? {
              outputPath,
              outputBytes,
              elapsedSeconds,
            }
          : null,
        metadata: {
          jobId: this.jobId,
          sampleId: sample.id,
          setId: this.setId,
          codec: variant.codec,
          encoder: variant.encoder,
          preset: variant.preset,
          crf: variant.crf,
          exitCode,
          stderrTail,
        },
        revertible: false,
      });
    })();

    if (success) {
      this.progress.variantsCompleted += 1;
      this.progress.totalEncodeSeconds += elapsedSeconds;
      this.progress.totalOutputBytes += outputBytes;
    } else {
      this.progress.variantsFailed += 1;
      this.incrementProgress({ errorsCount: 1 });
      this.logEvent(
        "error",
        "variant_failed",
        `Variant ${variant.id} (${variant.encoder} p=${variant.preset} crf=${variant.crf}) failed: ${
          runError ?? `exit ${exitCode}`
        }`,
        { sampleId: sample.id, stderrTail }
      );
    }
    this.incrementProgress({
      itemsProcessed: 1,
      bytesProcessed: outputBytes,
      progressJson: this.progress,
    });
  }

  private outputPathFor(sample: SampleRow, variant: VariantRow, extension: string): string {
    if (!this.set) throw new Error("invariant: set not loaded");
    // <scratch>/set-<id>/sample-<sid>/variant-<vid>.<ext>
    const file = `variant-${variant.id}.${extension}`;
    return path.join(
      this.set.scratch_root,
      `set-${this.setId}`,
      `sample-${sample.id}`,
      file
    );
  }

  private markSetReady(): void {
    // 'ready' when every variant has terminal status.
    const stillPending = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM encoding_variants v
           JOIN encoding_samples s ON s.id = v.sample_id
          WHERE s.set_id = ? AND v.status IN ('pending', 'running')`
      )
      .get(this.setId) as { n: number };
    if (stillPending.n === 0) {
      this.db
        .prepare(`UPDATE encoding_sample_sets SET status = 'ready' WHERE id = ?`)
        .run(this.setId);
    }
  }

  private broadcast(): void {
    this.incrementProgress({ progressJson: this.progress });
  }
}
