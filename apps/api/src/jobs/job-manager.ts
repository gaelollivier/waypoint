import type { Database } from "bun:sqlite";

export type JobType = "scan" | "copy" | "verify" | "backup";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type JobEventLevel = "info" | "warning" | "error";

export interface JobRow {
  id: number;
  type: JobType;
  parent_job_id: number | null;
  status: JobStatus;
  phase: string | null;
  active_sub_job_id: number | null;
  source_disk_id: number | null;
  dest_disk_id: number | null;
  target_disk_id: number | null;
  payload_json: string | null;
  progress_json: string | null;
  bytes_processed: number;
  items_processed: number;
  warnings_count: number;
  non_critical_errors_count: number;
  errors_count: number;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  created_by: "user" | "composite";
  created_at: string;
}

export interface JobEventRow {
  id: number;
  job_id: number;
  timestamp: string;
  level: JobEventLevel;
  category: string;
  message: string;
  payload_json: string | null;
}

// Valid status transitions. Terminal states have no outgoing edges.
const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued:    ["running", "cancelled"],
  running:   ["paused", "completed", "failed", "cancelled"],
  paused:    ["running", "cancelled"],
  completed: [],
  failed:    [],
  cancelled: [],
};

export class JobManager {
  constructor(private db: Database) {}

  createJob(opts: {
    type: JobType;
    targetDiskId?: number | null;
    sourceDiskId?: number | null;
    destDiskId?: number | null;
    parentJobId?: number | null;
    payload?: unknown;
    createdBy?: "user" | "composite";
  }): JobRow {
    return this.db
      .prepare(
        `INSERT INTO jobs
           (type, target_disk_id, source_disk_id, dest_disk_id, parent_job_id,
            payload_json, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
         RETURNING *`
      )
      .get(
        opts.type,
        opts.targetDiskId ?? null,
        opts.sourceDiskId ?? null,
        opts.destDiskId ?? null,
        opts.parentJobId ?? null,
        opts.payload !== undefined ? JSON.stringify(opts.payload) : null,
        opts.createdBy ?? "user"
      ) as JobRow;
  }

  getJob(id: number): JobRow | null {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
  }

  listJobs(filters: {
    status?: JobStatus;
    type?: JobType;
    targetDiskId?: number;
    limit?: number;
  } = {}): JobRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status)       { conditions.push("status = ?");         params.push(filters.status); }
    if (filters.type)         { conditions.push("type = ?");           params.push(filters.type); }
    if (filters.targetDiskId) { conditions.push("target_disk_id = ?"); params.push(filters.targetDiskId); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(filters.limit ?? 100);
    return this.db.prepare(
      `SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ?`
    ).all(...params) as JobRow[];
  }

  /**
   * Transitions a job to a new status, enforcing the valid-transition table.
   * Automatically sets `started_at` on first transition to `running`,
   * and `completed_at` on terminal states.
   */
  transition(id: number, to: JobStatus): JobRow {
    const job = this.getJob(id);
    if (!job) throw new Error(`Job ${id} not found`);

    const allowed = VALID_TRANSITIONS[job.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid transition for job ${id}: '${job.status}' → '${to}'`
      );
    }

    const now = new Date().toISOString();
    const isTerminal = to === "completed" || to === "failed" || to === "cancelled";

    this.db
      .prepare(
        `UPDATE jobs SET
           status       = ?,
           started_at   = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
           updated_at   = ?
         WHERE id = ?`
      )
      .run(to, to, now, isTerminal ? 1 : 0, now, now, id);

    return this.getJob(id)!;
  }

  /**
   * Atomically adds delta values to the job's aggregate counters and optionally
   * updates `progress_json` (live metrics like files/sec, ETA).
   */
  incrementProgress(
    id: number,
    delta: {
      bytesProcessed?: number;
      itemsProcessed?: number;
      warningsCount?: number;
      nonCriticalErrorsCount?: number;
      errorsCount?: number;
      progressJson?: unknown;
    }
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET
           bytes_processed           = bytes_processed           + ?,
           items_processed           = items_processed           + ?,
           warnings_count            = warnings_count            + ?,
           non_critical_errors_count = non_critical_errors_count + ?,
           errors_count              = errors_count              + ?,
           progress_json             = COALESCE(?, progress_json),
           updated_at                = ?
         WHERE id = ?`
      )
      .run(
        delta.bytesProcessed ?? 0,
        delta.itemsProcessed ?? 0,
        delta.warningsCount ?? 0,
        delta.nonCriticalErrorsCount ?? 0,
        delta.errorsCount ?? 0,
        delta.progressJson !== undefined ? JSON.stringify(delta.progressJson) : null,
        now,
        id
      );
  }

  logEvent(
    jobId: number,
    level: JobEventLevel,
    category: string,
    message: string,
    payload?: unknown
  ): void {
    this.db
      .prepare(
        `INSERT INTO job_events (job_id, level, category, message, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        jobId,
        level,
        category,
        message,
        payload !== undefined ? JSON.stringify(payload) : null
      );
  }

  getEvents(jobId: number, limit = 200): JobEventRow[] {
    return this.db
      .prepare(
        "SELECT * FROM job_events WHERE job_id = ? ORDER BY timestamp ASC LIMIT ?"
      )
      .all(jobId, limit) as JobEventRow[];
  }

  getDiskEvents(
    diskId: number,
    opts: { level?: string; jobId?: number; limit?: number; offset?: number } = {}
  ): JobEventRow[] {
    const { level, jobId, limit = 200, offset = 0 } = opts;
    const clauses: string[] = [
      "j.target_disk_id = ? OR j.source_disk_id = ? OR j.dest_disk_id = ?"
    ];
    const params: unknown[] = [diskId, diskId, diskId];

    if (level) { clauses.push("e.level = ?"); params.push(level); }
    if (jobId != null) { clauses.push("e.job_id = ?"); params.push(jobId); }

    params.push(limit, offset);

    return this.db
      .prepare(
        `SELECT e.*
         FROM job_events e
         JOIN jobs j ON j.id = e.job_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY e.timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params) as JobEventRow[];
  }
}
