import type { Database } from "bun:sqlite";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { processNextQueueEntry, recomputeAggregates } from "./walker";
import { trace } from "../../diag/trace";

export class ScanJobRunner extends JobRunner {
  private db: Database;
  private diskId: number;
  private mountPath: string;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    diskId: number;
    mountPath: string;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.diskId = opts.diskId;
    this.mountPath = opts.mountPath;
  }

  protected async execute(): Promise<void> {
    trace("scan_start", { job_id: this.jobId, disk_id: this.diskId, mount: this.mountPath });
    this.initOrResumeQueue();

    // Resolve the previous completed scan for this disk so the walker can
    // reuse hashes when mtime+size are unchanged (avoids re-reading files).
    const prevScanRow = this.db
      .prepare("SELECT last_scan_job_id FROM disks WHERE id = ?")
      .get(this.diskId) as { last_scan_job_id: number | null } | null;
    const previousScanId = prevScanRow?.last_scan_job_id ?? null;

    let total = 0;
    let dirsProcessed = 0;
    while (true) {
      await this.checkPause();

      const result = await processNextQueueEntry(
        this.db,
        this.jobId,
        this.diskId,
        previousScanId,
        this.jobManager
      );

      if (result === null) break; // queue exhausted

      this.incrementProgress({
        itemsProcessed: result.filesIndexed,
        bytesProcessed: result.bytesIndexed,
      });
      total += result.filesIndexed;
      dirsProcessed++;

      // Yield to the event loop between directories so HTTP requests, SSE
      // writes, and the flush timer can run. Without this, fast scans (>10k
      // files/sec) starve Hono and the API appears frozen until the scan ends.
      await new Promise<void>((r) => setImmediate(r));
    }

    trace("scan_walker_done", { job_id: this.jobId, dirs: dirsProcessed, files: total });

    // Recompute directory aggregates once at the very end. Async because the
    // writeback yields to the event loop every YIELD_EVERY rows so HTTP stays
    // responsive while ~thousands of small UPDATEs run.
    const tAgg = performance.now();
    await recomputeAggregates(this.db, this.jobId);
    trace("scan_aggregates_done", { job_id: this.jobId, ms: Math.round(performance.now() - tAgg) });

    // Update the disk's last_scan_at / last_scan_job_id
    this.db
      .prepare(
        `UPDATE disks
         SET last_scan_job_id = ?, last_scan_at = ?
         WHERE id = ?`
      )
      .run(this.jobId, new Date().toISOString(), this.diskId);

    this.logEvent("info", "progress_milestone", `Scan complete. ${total} files indexed.`);
    trace("scan_end", { job_id: this.jobId });
  }

  /**
   * Seeds the walk queue with the root directory on a fresh scan.
   * On resume: resets any in_progress entries back to pending so they
   * are fully reprocessed (partial directory processing is not safe to resume
   * mid-way — simpler and correct to redo the directory).
   */
  private initOrResumeQueue(): void {
    const existing = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM scan_walk_queue WHERE scan_job_id = ?"
      )
      .get(this.jobId) as { n: number };

    if (existing.n === 0) {
      // Fresh scan — enqueue root
      this.db
        .prepare(
          `INSERT INTO scan_walk_queue
             (scan_job_id, disk_id, path, parent_directory_id, status)
           VALUES (?, ?, ?, NULL, 'pending')`
        )
        .run(this.jobId, this.diskId, this.mountPath);
    } else {
      // Resume — reset any in_progress entries back to pending
      this.db
        .prepare(
          `UPDATE scan_walk_queue SET status = 'pending', started_at = NULL
           WHERE scan_job_id = ? AND status = 'in_progress'`
        )
        .run(this.jobId);
    }
  }
}
