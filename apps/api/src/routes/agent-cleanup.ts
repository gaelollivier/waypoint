import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";

// ---------------------------------------------------------------------------
// Agent-driven cleanup support: deletion history, freeform notes, and
// path-keyed cleanup suggestions. Suggestions are advisory rows in SQLite —
// they are NEVER applied by this router. The web UI's Apply button calls the
// existing /api/disks/:id/duplicates/cleanup endpoint, which enforces the
// browser-UA + initiatedFromWebUI guardrails. Suggestions here only describe
// what an agent thinks should happen; humans still pull the trigger.
// ---------------------------------------------------------------------------

export const agentCleanupRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /api/disks/:id/cleanup/history
// Paged past deletion events on this disk, with the surviving sibling paths
// for each deleted file (so an agent can mine keep-vs-delete patterns).
// Each row corresponds to one deletion event; siblings come from the same
// scan snapshot the deletion was made against.
// Query params: limit (default 100, max 500), offset (default 0)
// ---------------------------------------------------------------------------
agentCleanupRouter.get("/history", (c) => {
  const diskId = Number(c.req.param("id"));
  const limit  = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  // Pull deletions on this disk, newest first. The join through files gives
  // us hash + path + scan_id; disk_id is filtered at the files level (PK
  // join on file_id is index-backed).
  const rows = db
    .prepare(
      `SELECT
         df.deleted_at,
         df.scan_id,
         f.id           AS file_id,
         f.full_hash,
         f.sampled_hash,
         f.size_bytes,
         f.path
       FROM deleted_files df
       JOIN files f ON f.id = df.file_id
       WHERE f.disk_id = ?
       ORDER BY df.deleted_at DESC, df.file_id DESC
       LIMIT ? OFFSET ?`
    )
    .all(diskId, limit, offset) as Array<{
      deleted_at: string;
      scan_id: number;
      file_id: number;
      full_hash: string | null;
      sampled_hash: string | null;
      size_bytes: number;
      path: string;
    }>;

  // For each deletion, find sibling paths in the same scan with the same
  // full_hash. A sibling is a file with matching hash that was NOT itself
  // deleted (i.e. it's a candidate "keep" copy). We only consider full-hash
  // siblings since the cleanup endpoint only supports full-hash groups.
  const siblingStmt = db.prepare(
    `SELECT f.path
     FROM files f
     LEFT JOIN deleted_files df ON df.file_id = f.id
     WHERE f.scan_id = ?
       AND f.full_hash = ?
       AND f.size_bytes = ?
       AND f.id != ?
     ORDER BY (CASE WHEN df.file_id IS NULL THEN 0 ELSE 1 END), f.path
     LIMIT 10`
  );

  const events = rows.map((r) => {
    const siblings = r.full_hash
      ? (siblingStmt.all(r.scan_id, r.full_hash, r.size_bytes, r.file_id) as Array<{ path: string }>)
      : [];
    return {
      deletedAt: r.deleted_at,
      scanId: r.scan_id,
      deletedPath: r.path,
      sizeBytes: r.size_bytes,
      contentHash: r.full_hash,
      sampledHash: r.sampled_hash,
      siblingPaths: siblings.map((s) => s.path),
    };
  });

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM deleted_files df
       JOIN files f ON f.id = df.file_id
       WHERE f.disk_id = ?`
    )
    .get(diskId) as { n: number };

  return c.json({
    diskId,
    total: total.n,
    limit,
    offset,
    events,
  });
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/cleanup/notes
// Returns the agent's freeform markdown notes for this disk. Returns
// { body: "", updatedAt: null } if no row exists yet.
// ---------------------------------------------------------------------------
agentCleanupRouter.get("/notes", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const row = db
    .prepare(`SELECT body, updated_at FROM agent_notes WHERE disk_id = ?`)
    .get(diskId) as { body: string; updated_at: string } | null;

  return c.json({
    diskId,
    body: row?.body ?? "",
    updatedAt: row?.updated_at ?? null,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/disks/:id/cleanup/notes
// Upserts the agent notes blob for this disk.
// Body: { body: string }
// ---------------------------------------------------------------------------
agentCleanupRouter.put("/notes", async (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const body = await c.req.json<{ body?: unknown }>().catch(() => ({} as { body?: unknown }));
  if (typeof body.body !== "string") {
    return c.json({ error: "Body must include a string 'body' field" }, 400);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_notes (disk_id, body, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(disk_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`
  ).run(diskId, body.body, now);

  return c.json({ diskId, body: body.body, updatedAt: now });
});

// ---------------------------------------------------------------------------
// Suggestion resolution
//
// Suggestions are stored by path + content_hash and must resolve against
// the LATEST completed duplicate_detection job for the disk. Resolution can
// fail in several ways — paths gone, hash drifted, no detection run yet —
// and those failures are surfaced as a `stale` variant so the UI can keep
// rendering the row without offering an Apply.
// ---------------------------------------------------------------------------

interface ResolvedFile {
  fileId: number;
  path: string;
  fullHash: string | null;
}

interface ResolvedSuggestion {
  resolved: true;
  duplicateGroupId: number;
  keepFile: { fileId: number; path: string };
  deleteFiles: Array<{ fileId: number; path: string }>;
}

interface StaleSuggestion {
  resolved: false;
  staleReason: string;
}

function resolveSuggestion(
  db: ReturnType<typeof getDb>,
  ctx: {
    duplicateJobId: number | null;
    scanId: number | null;
  },
  suggestion: {
    contentHash: string;
    keepPath: string;
    deletePaths: string[];
  }
): ResolvedSuggestion | StaleSuggestion {
  if (ctx.duplicateJobId === null || ctx.scanId === null) {
    return { resolved: false, staleReason: "no completed duplicate detection for this disk" };
  }

  const allPaths = [suggestion.keepPath, ...suggestion.deletePaths];
  const placeholders = allPaths.map(() => "?").join(", ");
  const fileRows = db
    .prepare(
      `SELECT id, path, full_hash
       FROM files
       WHERE scan_id = ? AND path IN (${placeholders})`
    )
    .all(ctx.scanId, ...allPaths) as Array<{ id: number; path: string; full_hash: string | null }>;

  const byPath = new Map<string, ResolvedFile>();
  for (const r of fileRows) {
    byPath.set(r.path, { fileId: r.id, path: r.path, fullHash: r.full_hash });
  }

  const keep = byPath.get(suggestion.keepPath);
  if (!keep) {
    return { resolved: false, staleReason: `keep path no longer present in latest scan: ${suggestion.keepPath}` };
  }
  if (keep.fullHash !== suggestion.contentHash) {
    return { resolved: false, staleReason: "keep file hash drifted from suggestion content_hash" };
  }

  const deleteFiles: Array<{ fileId: number; path: string }> = [];
  for (const dp of suggestion.deletePaths) {
    const f = byPath.get(dp);
    if (!f) {
      return { resolved: false, staleReason: `delete path no longer present in latest scan: ${dp}` };
    }
    if (f.fullHash !== suggestion.contentHash) {
      return { resolved: false, staleReason: `delete file hash drifted: ${dp}` };
    }
    deleteFiles.push({ fileId: f.fileId, path: f.path });
  }

  // Find the duplicate group in the latest detection that contains the keep
  // file. Uses the new duplicate_group_files(file_id) index plus the existing
  // duplicate_groups_job index to constrain to this disk's latest job.
  const groupRow = db
    .prepare(
      `SELECT dgf.group_id
       FROM duplicate_group_files dgf
       JOIN duplicate_groups dg ON dg.id = dgf.group_id
       WHERE dgf.file_id = ?
         AND dg.duplicate_job_id = ?
         AND dg.content_hash = ?
       LIMIT 1`
    )
    .get(keep.fileId, ctx.duplicateJobId, suggestion.contentHash) as { group_id: number } | null;

  if (!groupRow) {
    return { resolved: false, staleReason: "no matching duplicate group in the latest detection" };
  }

  return {
    resolved: true,
    duplicateGroupId: groupRow.group_id,
    keepFile: { fileId: keep.fileId, path: keep.path },
    deleteFiles,
  };
}

// ---------------------------------------------------------------------------
// GET /api/disks/:id/cleanup/suggestions
// List suggestions. Defaults to status=pending. Resolves each pending row
// against the latest completed duplicate detection so the UI's Apply button
// has ready-to-send fileIds.
// Query params:
//   status — 'pending' (default) | 'applied' | 'dismissed' | 'all'
//   limit  — default 50, max 200
//   offset — default 0
// ---------------------------------------------------------------------------
agentCleanupRouter.get("/suggestions", (c) => {
  const diskId  = Number(c.req.param("id"));
  const status  = c.req.query("status") ?? "pending";
  const limit   = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset  = Number(c.req.query("offset") ?? 0);

  if (!["pending", "applied", "dismissed", "all"].includes(status)) {
    return c.json({ error: "Invalid status filter" }, 400);
  }

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  // Resolve latest duplicate-detection job + scan_id for this disk. Tiebreak
  // by `id DESC` so the most recently inserted job wins when completed_at is
  // identical (test fixtures hit this; real timestamps can too).
  const latestJob = db
    .prepare(
      `SELECT id, payload_json FROM jobs
       WHERE type = 'duplicate_detection'
         AND target_disk_id = ?
         AND status = 'completed'
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`
    )
    .get(diskId) as { id: number; payload_json: string | null } | null;

  let duplicateJobId: number | null = null;
  let scanId: number | null = null;
  if (latestJob && latestJob.payload_json) {
    const payload = JSON.parse(latestJob.payload_json) as { scanId?: number };
    if (Number.isInteger(payload.scanId)) {
      duplicateJobId = latestJob.id;
      scanId = payload.scanId as number;
    }
  }

  const whereStatus = status === "all" ? "" : "AND status = ?";
  const params: Array<number | string> = [diskId];
  if (status !== "all") params.push(status);
  params.push(limit, offset);

  const rows = db
    .prepare(
      `SELECT id, content_hash, keep_path, delete_paths, size_bytes, rationale,
              status, created_at, applied_at, dismissed_at
       FROM cleanup_suggestions
       WHERE disk_id = ? ${whereStatus}
       ORDER BY size_bytes DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params) as Array<{
      id: number;
      content_hash: string;
      keep_path: string;
      delete_paths: string;
      size_bytes: number;
      rationale: string;
      status: "pending" | "applied" | "dismissed";
      created_at: string;
      applied_at: string | null;
      dismissed_at: string | null;
    }>;

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cleanup_suggestions WHERE disk_id = ? ${whereStatus}`
    )
    .get(...(status === "all" ? [diskId] : [diskId, status])) as { n: number };

  const suggestions = rows.map((r) => {
    const deletePaths = JSON.parse(r.delete_paths) as string[];
    const wastedBytes = r.size_bytes * deletePaths.length;
    const base = {
      id: r.id,
      contentHash: r.content_hash,
      keepPath: r.keep_path,
      deletePaths,
      sizeBytes: r.size_bytes,
      wastedBytes,
      rationale: r.rationale,
      status: r.status,
      createdAt: r.created_at,
      appliedAt: r.applied_at,
      dismissedAt: r.dismissed_at,
    };

    // Only pending suggestions need resolution — applied/dismissed are historical.
    if (r.status !== "pending") {
      return { ...base, resolved: false as const, staleReason: null };
    }

    const resolution = resolveSuggestion(db, { duplicateJobId, scanId }, {
      contentHash: r.content_hash,
      keepPath: r.keep_path,
      deletePaths,
    });
    if (resolution.resolved) {
      return {
        ...base,
        resolved: true as const,
        duplicateGroupId: resolution.duplicateGroupId,
        keepFile: resolution.keepFile,
        deleteFiles: resolution.deleteFiles,
      };
    } else {
      return {
        ...base,
        resolved: false as const,
        staleReason: resolution.staleReason,
      };
    }
  });

  return c.json({
    diskId,
    duplicateJobId,
    total: totalRow.n,
    limit,
    offset,
    suggestions,
  });
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/cleanup/suggestions
// Create a new suggestion. If a pending suggestion exists for the same
// (disk_id, content_hash), it is replaced by the new one (the unique partial
// index enforces one pending row per content hash).
// Body: { contentHash, keepPath, deletePaths[], sizeBytes, rationale? }
// ---------------------------------------------------------------------------
interface CreateSuggestionBody {
  contentHash: string;
  keepPath: string;
  deletePaths: string[];
  sizeBytes: number;
  rationale?: string;
}

agentCleanupRouter.post("/suggestions", async (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const body = await c.req.json<CreateSuggestionBody>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (typeof body.contentHash !== "string" || body.contentHash.length === 0) {
    return c.json({ error: "contentHash must be a non-empty string" }, 400);
  }
  if (typeof body.keepPath !== "string" || !body.keepPath.startsWith("/")) {
    return c.json({ error: "keepPath must be an absolute path" }, 400);
  }
  if (!Array.isArray(body.deletePaths) || body.deletePaths.length === 0) {
    return c.json({ error: "deletePaths must be a non-empty array" }, 400);
  }
  for (const dp of body.deletePaths) {
    if (typeof dp !== "string" || !dp.startsWith("/")) {
      return c.json({ error: "Every deletePaths entry must be an absolute path" }, 400);
    }
    if (dp === body.keepPath) {
      return c.json({ error: "keepPath must not appear in deletePaths" }, 400);
    }
  }
  // Dedupe deletePaths so callers can't smuggle duplicate entries.
  const dedupedDeletes = Array.from(new Set(body.deletePaths));
  if (dedupedDeletes.length !== body.deletePaths.length) {
    return c.json({ error: "deletePaths contains duplicates" }, 400);
  }
  if (!Number.isFinite(body.sizeBytes) || body.sizeBytes < 0) {
    return c.json({ error: "sizeBytes must be a non-negative number" }, 400);
  }
  const rationale = typeof body.rationale === "string" ? body.rationale : "";

  // Replace any existing pending suggestion for this content_hash, then insert.
  const insertedId = db.transaction(() => {
    db.prepare(
      `DELETE FROM cleanup_suggestions
       WHERE disk_id = ? AND content_hash = ? AND status = 'pending'`
    ).run(diskId, body.contentHash);

    const result = db
      .prepare(
        `INSERT INTO cleanup_suggestions
           (disk_id, content_hash, keep_path, delete_paths, size_bytes, rationale)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        diskId,
        body.contentHash,
        body.keepPath,
        JSON.stringify(dedupedDeletes),
        Math.floor(body.sizeBytes),
        rationale
      );
    return Number(result.lastInsertRowid);
  })();

  return c.json({ id: insertedId, diskId }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/cleanup/suggestions/:suggestionId/applied
// Mark a suggestion as applied. Called by the UI *after* the existing
// /duplicates/cleanup endpoint completes successfully.
// ---------------------------------------------------------------------------
agentCleanupRouter.post("/suggestions/:suggestionId/applied", (c) => {
  const diskId = Number(c.req.param("id"));
  const suggestionId = Number(c.req.param("suggestionId"));
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) {
    return c.json({ error: "Invalid suggestionId" }, 400);
  }

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE cleanup_suggestions
       SET status = 'applied', applied_at = ?
       WHERE id = ? AND disk_id = ? AND status = 'pending'`
    )
    .run(now, suggestionId, diskId);

  if (result.changes === 0) {
    return c.json({ error: "Suggestion not found or not in pending state" }, 404);
  }
  return c.json({ id: suggestionId, status: "applied", appliedAt: now });
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/cleanup/suggestions/:suggestionId/dismissed
// Mark a pending suggestion as dismissed. Kept in the DB for audit.
// ---------------------------------------------------------------------------
agentCleanupRouter.post("/suggestions/:suggestionId/dismissed", (c) => {
  const diskId = Number(c.req.param("id"));
  const suggestionId = Number(c.req.param("suggestionId"));
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) {
    return c.json({ error: "Invalid suggestionId" }, 400);
  }

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE cleanup_suggestions
       SET status = 'dismissed', dismissed_at = ?
       WHERE id = ? AND disk_id = ? AND status = 'pending'`
    )
    .run(now, suggestionId, diskId);

  if (result.changes === 0) {
    return c.json({ error: "Suggestion not found or not in pending state" }, 404);
  }
  return c.json({ id: suggestionId, status: "dismissed", dismissedAt: now });
});
