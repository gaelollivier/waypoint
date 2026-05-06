import type { Database } from "bun:sqlite";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { processNextQueueEntry, recomputeAggregates } from "./walker";

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
    this.initOrResumeQueue();

    let total = 0;
    while (true) {
      await this.checkPause();

      const result = await processNextQueueEntry(
        this.db,
        this.jobId,
        this.diskId,
        this.jobManager
      );

      if (result === null) break; // queue exhausted

      this.incrementProgress({
        itemsProcessed: result.filesIndexed,
        bytesProcessed: result.bytesIndexed,
      });
      total += result.filesIndexed;
    }

    // Recompute directory aggregates once at the very end
    recomputeAggregates(this.db, this.diskId);

    // Update the disk's last_scan_at / last_scan_job_id
    this.db
      .prepare(
        `UPDATE disks
         SET last_scan_job_id = ?, last_scan_at = ?
         WHERE id = ?`
      )
      .run(this.jobId, new Date().toISOString(), this.diskId);

    this.logEvent("info", "progress_milestone", `Scan complete. ${total} files indexed.`);
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
