import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { recordAudit, classifyActor } from "../lib/audit";

// ---------------------------------------------------------------------------
// Per-disk exclusion list for duplicate detection.
//
// A row here marks a directory (or single file path) as "ignore for
// duplicate-detection purposes" — both at the GROUP BY stage and at the
// per-group member listing. Exclusions do NOT affect scan, diff, or copy.
// See `lib/excluded-paths.ts` for the matching SQL fragment.
// ---------------------------------------------------------------------------

export const excludedPathsRouter = new Hono();

interface ExcludedPathRow {
  id: number;
  disk_id: number;
  path: string;
  reason: string;
  created_at: string;
}

function format(row: ExcludedPathRow) {
  return {
    id: row.id,
    diskId: row.disk_id,
    path: row.path,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

// Strip a trailing slash so `/foo/bar` and `/foo/bar/` are stored
// canonically. The matching SQL uses `path = e.path OR path LIKE e.path
// || '/%'` which only behaves correctly when stored without trailing
// slash.
function normalizePath(p: string): string {
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

// GET /api/disks/:id/excluded-paths
excludedPathsRouter.get("/", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const rows = db
    .prepare(
      `SELECT id, disk_id, path, reason, created_at
       FROM excluded_paths
       WHERE disk_id = ?
       ORDER BY path`
    )
    .all(diskId) as ExcludedPathRow[];

  return c.json({ diskId, exclusions: rows.map(format) });
});

// POST /api/disks/:id/excluded-paths   body: { path: string, reason?: string }
excludedPathsRouter.post("/", async (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const body = await c.req
    .json<{ path?: unknown; reason?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (typeof body.path !== "string" || !body.path.startsWith("/")) {
    return c.json({ error: "path must be an absolute path starting with /" }, 400);
  }
  const path = normalizePath(body.path);
  if (path.length < 2) {
    return c.json({ error: "path must not be the filesystem root" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason : "";

  const existing = db
    .prepare(`SELECT id, disk_id, path, reason, created_at FROM excluded_paths WHERE disk_id = ? AND path = ?`)
    .get(diskId, path) as ExcludedPathRow | null;
  if (existing) {
    return c.json(format(existing), 200);
  }

  const userAgent = c.req.header("User-Agent") ?? null;
  const inserted = db.transaction(() => {
    const row = db
      .prepare(
        `INSERT INTO excluded_paths (disk_id, path, reason)
         VALUES (?, ?, ?)
         RETURNING id, disk_id, path, reason, created_at`
      )
      .get(diskId, path, reason) as ExcludedPathRow;
    recordAudit(db, {
      action: "excluded_path_add",
      actor: classifyActor(userAgent),
      userAgent,
      diskId,
      targetKind: "excluded_path",
      targetId: row.id,
      targetPath: row.path,
      after: format(row),
    });
    return row;
  })();

  return c.json(format(inserted), 201);
});

// DELETE /api/disks/:id/excluded-paths/:exclusionId
excludedPathsRouter.delete("/:exclusionId", (c) => {
  const diskId = Number(c.req.param("id"));
  const exclusionId = Number(c.req.param("exclusionId"));
  if (!Number.isInteger(exclusionId) || exclusionId <= 0) {
    return c.json({ error: "Invalid exclusionId" }, 400);
  }

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const existing = db
    .prepare(
      `SELECT id, disk_id, path, reason, created_at FROM excluded_paths WHERE id = ? AND disk_id = ?`
    )
    .get(exclusionId, diskId) as ExcludedPathRow | null;
  if (!existing) {
    return c.json({ error: "Exclusion not found for this disk" }, 404);
  }

  const userAgent = c.req.header("User-Agent") ?? null;
  db.transaction(() => {
    db.prepare(`DELETE FROM excluded_paths WHERE id = ?`).run(exclusionId);
    recordAudit(db, {
      action: "excluded_path_remove",
      actor: classifyActor(userAgent),
      userAgent,
      diskId,
      targetKind: "excluded_path",
      targetId: existing.id,
      targetPath: existing.path,
      before: format(existing),
    });
  })();

  return c.json({ id: exclusionId, deleted: true });
});
