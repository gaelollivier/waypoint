import type { Database } from "bun:sqlite";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { trace } from "../../diag/trace";
import { EXCLUDED_NAMES_SQL } from "../../lib/excluded-names";

const INSERT_BATCH_SIZE = 500;

interface DuplicateGroupRow {
  sampled_hash: string;
  size_bytes: number;
  file_count: number;
}

interface DuplicateFileRow {
  file_id: number;
  path: string;
}

export class DuplicateDetectionJobRunner extends JobRunner {
  private db: Database;
  private diskId: number;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    diskId: number;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.diskId = opts.diskId;
  }

  protected async execute(): Promise<void> {
    trace("duplicate_detection_start", { job_id: this.jobId, disk_id: this.diskId });
    const t0 = performance.now();

    // ── Phase 1: find all duplicate hashes on this disk ─────────────────────
    await this.checkPause();

    const groups = this.db
      .prepare(
        `SELECT sampled_hash, size_bytes, COUNT(*) AS file_count
         FROM files
         WHERE disk_id = ?
           AND sampled_hash IS NOT NULL
           AND ${EXCLUDED_NAMES_SQL}
         GROUP BY sampled_hash
         HAVING file_count > 1
         ORDER BY size_bytes DESC`
      )
      .all(this.diskId) as DuplicateGroupRow[];

    const totalWastedBytes = groups.reduce(
      (acc, g) => acc + g.size_bytes * (g.file_count - 1),
      0
    );

    trace("duplicate_detection_groups_found", {
      job_id: this.jobId,
      groups: groups.length,
      wasted_bytes: totalWastedBytes,
    });

    this.logEvent(
      "info",
      "progress_milestone",
      `Found ${groups.length} duplicate group${groups.length === 1 ? "" : "s"} — ${totalWastedBytes} bytes wasted`
    );

    // ── Phase 2: prepare insert statements ──────────────────────────────────
    await this.checkPause();

    const insertGroup = this.db.prepare(
      `INSERT INTO duplicate_groups
         (duplicate_job_id, sampled_hash, file_count, size_bytes, wasted_bytes)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    );

    const selectMembers = this.db.prepare(
      `SELECT id AS file_id, path
       FROM files
       WHERE disk_id = ?
         AND sampled_hash = ?
         AND ${EXCLUDED_NAMES_SQL}`
    );

    const insertFile = this.db.prepare(
      `INSERT INTO duplicate_group_files (group_id, file_id, path)
       VALUES (?, ?, ?)`
    );

    // ── Phase 3: insert groups and their members in batches ──────────────────
    for (let i = 0; i < groups.length; i += INSERT_BATCH_SIZE) {
      const batch = groups.slice(i, i + INSERT_BATCH_SIZE);

      this.db.transaction(() => {
        for (const g of batch) {
          const wastedBytes = g.size_bytes * (g.file_count - 1);
          const { id: groupId } = insertGroup.get(
            this.jobId,
            g.sampled_hash,
            g.file_count,
            g.size_bytes,
            wastedBytes
          ) as { id: number };

          const members = selectMembers.all(
            this.diskId,
            g.sampled_hash
          ) as DuplicateFileRow[];

          for (const m of members) {
            insertFile.run(groupId, m.file_id, m.path);
          }
        }
      })();

      this.incrementProgress({ itemsProcessed: batch.length });
      await new Promise<void>((r) => setImmediate(r));
      await this.checkPause();
    }

    trace("duplicate_detection_end", {
      job_id: this.jobId,
      groups: groups.length,
      ms: Math.round(performance.now() - t0),
    });

    this.logEvent(
      "info",
      "progress_milestone",
      `Duplicate detection complete: ${groups.length} group${groups.length === 1 ? "" : "s"}, ${totalWastedBytes} bytes wasted`
    );
  }
}
