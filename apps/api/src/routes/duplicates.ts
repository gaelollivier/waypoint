import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { DuplicateDetectionJobRunner } from "../jobs/duplicates/duplicate-job";

export const duplicatesRouter = new Hono();

// ---------------------------------------------------------------------------
// POST /api/disks/:id/duplicates
// Start a duplicate detection job for this disk.
// ---------------------------------------------------------------------------
duplicatesRouter.post("/", async (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();

  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  // Disk must have been scanned (files table has rows)
  const fileCount = db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE disk_id = ?")
    .get(diskId) as { n: number };
  if (fileCount.n === 0) {
    return c.json({ error: "Disk has no scan data — run a scan first" }, 409);
  }

  // At least one file must have a sampled_hash
  const hashCount = db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE disk_id = ? AND sampled_hash IS NOT NULL")
    .get(diskId) as { n: number };
  if (hashCount.n === 0) {
    return c.json({ error: "No hashed files found — run a scan first" }, 409);
  }

  // Only one active duplicate detection job per disk at a time
  const activeJob = db
    .prepare(
      `SELECT id FROM jobs
       WHERE type = 'duplicate_detection'
         AND target_disk_id = ?
         AND status IN ('queued', 'running', 'paused')
       LIMIT 1`
    )
    .get(diskId);
  if (activeJob) {
    return c.json({ error: "A duplicate detection job is already active for this disk" }, 409);
  }

  const jm = getJobManager();
  const job = jm.createJob({
    type: "duplicate_detection",
    targetDiskId: diskId,
  });

  const runner = new DuplicateDetectionJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    diskId,
  });

  registerRunner(job.id, runner);
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/duplicates
// Browse duplicate detection results for this disk.
// Query params:
//   duplicateJobId — defaults to latest completed job for this disk
//   sort           — 'wasted' (default) | 'total_size' | 'file_count' | 'size'
//   minSize        — minimum per-file size in bytes (default 0)
//   minCopies      — minimum file_count to include (default 2)
//   limit          — default 50, max 200
//   offset         — default 0
// ---------------------------------------------------------------------------
duplicatesRouter.get("/", (c) => {
  const diskId = Number(c.req.param("id"));
  const rawJobId  = c.req.query("duplicateJobId");
  const sort      = c.req.query("sort") ?? "wasted";
  const minSize   = Number(c.req.query("minSize")   ?? 0);
  const minCopies = Number(c.req.query("minCopies") ?? 2);
  const limit     = Math.min(Number(c.req.query("limit")  ?? 50), 200);
  const offset    = Number(c.req.query("offset") ?? 0);

  const db = getDb();

  // Resolve which job to use
  let duplicateJobId: number;
  if (rawJobId) {
    duplicateJobId = Number(rawJobId);
  } else {
    const latest = db
      .prepare(
        `SELECT id FROM jobs
         WHERE type = 'duplicate_detection'
           AND target_disk_id = ?
           AND status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`
      )
      .get(diskId) as { id: number } | null;
    if (!latest) {
      return c.json({ error: "No completed duplicate detection job found for this disk" }, 404);
    }
    duplicateJobId = latest.id;
  }

  // Build ORDER BY from sort param
  const orderBy: Record<string, string> = {
    wasted:     "dg.wasted_bytes DESC",
    total_size: "(dg.size_bytes * dg.file_count) DESC",
    file_count: "dg.file_count DESC",
    size:       "dg.size_bytes DESC",
  };
  const orderClause = orderBy[sort] ?? orderBy.wasted;

  // Fetch one page of groups
  const groups = db
    .prepare(
      `SELECT id, sampled_hash, file_count, size_bytes, wasted_bytes
       FROM duplicate_groups dg
       WHERE dg.duplicate_job_id = ?
         AND dg.size_bytes >= ?
         AND dg.file_count >= ?
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`
    )
    .all(duplicateJobId, minSize, minCopies, limit, offset) as Array<{
      id: number;
      sampled_hash: string;
      file_count: number;
      size_bytes: number;
      wasted_bytes: number;
    }>;

  // Fetch all file members for this page of groups in one query
  const groupIds = groups.map((g) => g.id);
  const filesMap = new Map<number, Array<{ fileId: number; path: string }>>();

  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(", ");
    const fileRows = db
      .prepare(
        `SELECT group_id, file_id, path
         FROM duplicate_group_files
         WHERE group_id IN (${placeholders})
         ORDER BY group_id, path`
      )
      .all(...groupIds) as Array<{ group_id: number; file_id: number; path: string }>;

    for (const r of fileRows) {
      if (!filesMap.has(r.group_id)) filesMap.set(r.group_id, []);
      filesMap.get(r.group_id)!.push({ fileId: r.file_id, path: r.path });
    }
  }

  // Totals (unfiltered by pagination)
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total_groups, COALESCE(SUM(wasted_bytes), 0) AS total_wasted_bytes
       FROM duplicate_groups
       WHERE duplicate_job_id = ?
         AND size_bytes >= ?
         AND file_count >= ?`
    )
    .get(duplicateJobId, minSize, minCopies) as { total_groups: number; total_wasted_bytes: number };

  return c.json({
    duplicateJobId,
    diskId,
    totalGroups: totals.total_groups,
    totalWastedBytes: totals.total_wasted_bytes,
    groups: groups.map((g) => ({
      id: g.id,
      sampledHash: g.sampled_hash,
      fileCount: g.file_count,
      sizeBytes: g.size_bytes,
      wastedBytes: g.wasted_bytes,
      files: filesMap.get(g.id) ?? [],
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/duplicates/jobs
// List all duplicate detection jobs for this disk.
// ---------------------------------------------------------------------------
duplicatesRouter.get("/jobs", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, status, target_disk_id, items_processed, created_at, completed_at
       FROM jobs
       WHERE type = 'duplicate_detection' AND target_disk_id = ?
       ORDER BY id DESC
       LIMIT 50`
    )
    .all(diskId) as Array<{
      id: number;
      status: string;
      target_disk_id: number;
      items_processed: number;
      created_at: string;
      completed_at: string | null;
    }>;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      diskId: r.target_disk_id,
      itemsProcessed: r.items_processed,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }))
  );
});
