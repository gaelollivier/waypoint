import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { DiffJobRunner } from "../jobs/diff/diff-job";

export const diffRouter = new Hono();

// ---------------------------------------------------------------------------
// POST /api/disks/:id/diff
// Start a diff job comparing this disk (source) against another (dest).
// Body: { destDiskId: number }
// ---------------------------------------------------------------------------
diffRouter.post("/", async (c) => {
  const sourceDiskId = Number(c.req.param("id"));
  const body = await c.req.json<{ destDiskId: number }>();

  if (!body.destDiskId) {
    return c.json({ error: "destDiskId is required" }, 400);
  }
  const destDiskId = Number(body.destDiskId);
  if (!Number.isFinite(destDiskId) || destDiskId <= 0) {
    return c.json({ error: "destDiskId must be a positive integer" }, 400);
  }

  const db = getDb();
  const sourceDisk = getDiskById(db, sourceDiskId);
  if (!sourceDisk) return c.json({ error: "Source disk not found" }, 404);

  const destDisk = getDiskById(db, destDiskId);
  if (!destDisk) return c.json({ error: "Destination disk not found" }, 404);

  // Verify both disks have been scanned (files table has rows)
  const sourceCount = db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE disk_id = ?")
    .get(sourceDiskId) as { n: number };
  if (sourceCount.n === 0) {
    return c.json({ error: "Source disk has no scan data — run a scan first" }, 409);
  }
  const destCount = db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE disk_id = ?")
    .get(destDiskId) as { n: number };
  if (destCount.n === 0) {
    return c.json({ error: "Destination disk has no scan data — run a scan first" }, 409);
  }

  // Only one active diff per source↔dest pair at a time
  const activeDiff = db
    .prepare(
      `SELECT id FROM jobs
       WHERE type = 'diff'
         AND source_disk_id = ?
         AND dest_disk_id = ?
         AND status IN ('queued', 'running', 'paused')
       LIMIT 1`
    )
    .get(sourceDiskId, destDiskId);
  if (activeDiff) {
    return c.json({ error: "A diff is already active for this source↔dest pair" }, 409);
  }

  const jm = getJobManager();
  const job = jm.createJob({
    type: "diff",
    sourceDiskId,
    destDiskId,
  });

  const runner = new DiffJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    sourceDiskId,
    destDiskId,
  });

  registerRunner(job.id, runner);
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/diff
// Browse the diff tree for a given source↔dest pair.
// Query: destDiskId (required), diffJobId (optional — defaults to latest
//        completed diff for this pair), parentPath (optional — defaults to root)
// ---------------------------------------------------------------------------
diffRouter.get("/", (c) => {
  const sourceDiskId = Number(c.req.param("id"));
  const rawDestDiskId = c.req.query("destDiskId");
  const rawDiffJobId = c.req.query("diffJobId");
  const parentPath = c.req.query("parentPath") ?? "/";

  if (!rawDestDiskId) {
    return c.json({ error: "destDiskId query param is required" }, 400);
  }
  const destDiskId = Number(rawDestDiskId);

  const db = getDb();

  // Resolve which diff job to use
  let diffJobId: number;
  if (rawDiffJobId) {
    diffJobId = Number(rawDiffJobId);
  } else {
    // Latest completed diff for this source↔dest pair
    const latest = db
      .prepare(
        `SELECT id FROM jobs
         WHERE type = 'diff'
           AND source_disk_id = ?
           AND dest_disk_id = ?
           AND status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`
      )
      .get(sourceDiskId, destDiskId) as { id: number } | null;
    if (!latest) {
      return c.json({ error: "No completed diff found for this source↔dest pair" }, 404);
    }
    diffJobId = latest.id;
  }

  // Resolve the diff_dirs row for this parentPath
  const dirRow = db
    .prepare(
      `SELECT id, added_count, added_bytes, changed_count, changed_bytes,
              removed_count, removed_bytes, present_count, present_bytes
       FROM diff_dirs
       WHERE diff_job_id = ? AND path = ?`
    )
    .get(diffJobId, parentPath) as {
      id: number;
      added_count: number; added_bytes: number;
      changed_count: number; changed_bytes: number;
      removed_count: number; removed_bytes: number;
      present_count: number; present_bytes: number;
    } | null;

  if (!dirRow) {
    return c.json({ error: "Path not found in diff" }, 404);
  }

  // Child directories
  const subdirs = db
    .prepare(
      `SELECT id, path,
              added_count, added_bytes,
              changed_count, changed_bytes,
              removed_count, removed_bytes,
              present_count, present_bytes
       FROM diff_dirs
       WHERE diff_job_id = ? AND parent_id = ?
       ORDER BY (added_bytes + changed_bytes + removed_bytes) DESC`
    )
    .all(diffJobId, dirRow.id) as Array<{
      id: number; path: string;
      added_count: number; added_bytes: number;
      changed_count: number; changed_bytes: number;
      removed_count: number; removed_bytes: number;
      present_count: number; present_bytes: number;
    }>;

  // Direct files in this directory
  const files = db
    .prepare(
      `SELECT id, kind, path, size_bytes
       FROM diff_entries
       WHERE diff_job_id = ? AND diff_dir_id = ?
       ORDER BY size_bytes DESC`
    )
    .all(diffJobId, dirRow.id) as Array<{
      id: number;
      kind: string;
      path: string;
      size_bytes: number;
    }>;

  // Build breadcrumb
  const breadcrumb = buildBreadcrumb(db, diffJobId, dirRow.id);

  // Root-level totals (from root diff_dir row)
  const rootRow = db
    .prepare(
      `SELECT added_count, added_bytes, changed_count, changed_bytes,
              removed_count, removed_bytes, present_count, present_bytes
       FROM diff_dirs
       WHERE diff_job_id = ? AND parent_id IS NULL`
    )
    .get(diffJobId) as {
      added_count: number; added_bytes: number;
      changed_count: number; changed_bytes: number;
      removed_count: number; removed_bytes: number;
      present_count: number; present_bytes: number;
    } | null;

  const entries = [
    ...subdirs.map((d) => ({
      kind: "directory" as const,
      name: path.basename(d.path),
      path: d.path,
      sizeBytes: d.added_bytes + d.changed_bytes + d.present_bytes + d.removed_bytes,
      addedCount: d.added_count, addedBytes: d.added_bytes,
      changedCount: d.changed_count, changedBytes: d.changed_bytes,
      removedCount: d.removed_count, removedBytes: d.removed_bytes,
      presentCount: d.present_count, presentBytes: d.present_bytes,
    })),
    ...files.map((f) => ({
      kind: "file" as const,
      name: path.basename(f.path),
      path: f.path,
      sizeBytes: f.size_bytes,
      diffKind: f.kind as "added" | "changed" | "removed" | "present",
    })),
  ].sort((a, b) => b.sizeBytes - a.sizeBytes);

  return c.json({
    diffJobId,
    sourceDiskId,
    destDiskId,
    parentPath,
    breadcrumb,
    totalAdded: rootRow?.added_count ?? 0,
    totalAddedBytes: rootRow?.added_bytes ?? 0,
    totalChanged: rootRow?.changed_count ?? 0,
    totalChangedBytes: rootRow?.changed_bytes ?? 0,
    totalRemoved: rootRow?.removed_count ?? 0,
    totalRemovedBytes: rootRow?.removed_bytes ?? 0,
    totalPresent: rootRow?.present_count ?? 0,
    totalPresentBytes: rootRow?.present_bytes ?? 0,
    currentDir: {
      addedCount: dirRow.added_count, addedBytes: dirRow.added_bytes,
      changedCount: dirRow.changed_count, changedBytes: dirRow.changed_bytes,
      removedCount: dirRow.removed_count, removedBytes: dirRow.removed_bytes,
      presentCount: dirRow.present_count, presentBytes: dirRow.present_bytes,
    },
    entries,
  });
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/diff/jobs
// List all diff jobs where this disk is the source.
// Useful for the UI to list past diffs.
// ---------------------------------------------------------------------------
diffRouter.get("/jobs", (c) => {
  const sourceDiskId = Number(c.req.param("id"));
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT j.id, j.status, j.source_disk_id, j.dest_disk_id,
              j.items_processed, j.created_at, j.completed_at,
              d.label AS dest_label
       FROM jobs j
       LEFT JOIN disks d ON d.id = j.dest_disk_id
       WHERE j.type = 'diff' AND j.source_disk_id = ?
       ORDER BY j.id DESC
       LIMIT 50`
    )
    .all(sourceDiskId) as Array<{
      id: number; status: string;
      source_disk_id: number; dest_disk_id: number;
      items_processed: number;
      created_at: string; completed_at: string | null;
      dest_label: string | null;
    }>;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      sourceDiskId: r.source_disk_id,
      destDiskId: r.dest_disk_id,
      destLabel: r.dest_label,
      itemsProcessed: r.items_processed,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }))
  );
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildBreadcrumb(
  db: ReturnType<typeof getDb>,
  diffJobId: number,
  dirId: number
): Array<{ name: string; path: string | null }> {
  const crumbs: Array<{ name: string; path: string | null }> = [];
  let current: number | null = dirId;

  while (current !== null) {
    const row = db
      .prepare("SELECT id, path, parent_id FROM diff_dirs WHERE id = ? AND diff_job_id = ?")
      .get(current, diffJobId) as {
        id: number;
        path: string;
        parent_id: number | null;
      } | null;
    if (!row) break;

    const name = row.path === "/" ? null : path.basename(row.path);
    crumbs.unshift({ name: name ?? "Root", path: row.path === "/" ? null : row.path });
    current = row.parent_id;
  }

  return crumbs;
}
