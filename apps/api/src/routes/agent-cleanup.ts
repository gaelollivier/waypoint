import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { getJobManager } from "../jobs";
import { getLockManager } from "../locks";
import {
  applyDuplicateCleanup,
  CleanupValidationError,
} from "../lib/duplicate-cleanup";

// ---------------------------------------------------------------------------
// Agent-driven cleanup support: deletion history, freeform notes, and
// path-keyed cleanup suggestions. A "suggestion" is a BATCH — a set of one
// or more (content_hash, keep_path, delete_paths) members the user can
// accept or reject as one unit. The batch apply endpoint enforces the same
// browser-UA + initiatedFromWebUI guardrails as manual cleanup, holds the
// disk write lock once across all members, and runs the shared
// applyDuplicateCleanup helper per member.
// ---------------------------------------------------------------------------

export const agentCleanupRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /api/disks/:id/cleanup/history
// Paged past deletion events on this disk with surviving sibling paths.
// (Unchanged from v1 — still a per-file history view.)
// ---------------------------------------------------------------------------
agentCleanupRouter.get("/history", (c) => {
  const diskId = Number(c.req.param("id"));
  const limit  = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

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

  return c.json({ diskId, total: total.n, limit, offset, events });
});

// ---------------------------------------------------------------------------
// GET / PUT /api/disks/:id/cleanup/notes
// One freeform markdown blob per disk. Unchanged from v1.
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
// Per-member resolution against the latest completed duplicate detection.
// Same shape as v1 — each member resolves independently — except the result
// no longer carries the suggestion id (the parent batch carries that).
// ---------------------------------------------------------------------------

interface ResolvedMember {
  resolved: true;
  duplicateGroupId: number;
  keepFile: { fileId: number; path: string };
  deleteFiles: Array<{ fileId: number; path: string }>;
}

interface StaleMember {
  resolved: false;
  staleReason: string;
}

function resolveMember(
  db: ReturnType<typeof getDb>,
  ctx: { duplicateJobId: number | null; scanId: number | null },
  member: { contentHash: string; keepPath: string; deletePaths: string[] }
): ResolvedMember | StaleMember {
  if (ctx.duplicateJobId === null || ctx.scanId === null) {
    return { resolved: false, staleReason: "no completed duplicate detection for this disk" };
  }

  const allPaths = [member.keepPath, ...member.deletePaths];
  const placeholders = allPaths.map(() => "?").join(", ");
  const fileRows = db
    .prepare(
      `SELECT id, path, full_hash
       FROM files
       WHERE scan_id = ? AND path IN (${placeholders})`
    )
    .all(ctx.scanId, ...allPaths) as Array<{ id: number; path: string; full_hash: string | null }>;

  const byPath = new Map(fileRows.map((r) => [r.path, r]));

  // Check which of these file IDs have already been cleaned up via a previous
  // apply. deleted_files records are written atomically with the physical
  // deletion, so any file present there is gone from disk.
  const foundIds = fileRows.map((r) => r.id);
  const deletedSet = new Set<number>();
  if (foundIds.length > 0) {
    const idPlaceholders = foundIds.map(() => "?").join(", ");
    const deletedRows = db
      .prepare(`SELECT file_id FROM deleted_files WHERE file_id IN (${idPlaceholders})`)
      .all(...foundIds) as Array<{ file_id: number }>;
    for (const r of deletedRows) deletedSet.add(r.file_id);
  }

  const keep = byPath.get(member.keepPath);
  if (!keep) {
    return { resolved: false, staleReason: `keep path no longer present in latest scan: ${member.keepPath}` };
  }
  if (keep.full_hash !== member.contentHash) {
    return { resolved: false, staleReason: "keep file hash drifted from suggestion content_hash" };
  }
  if (deletedSet.has(keep.id)) {
    return { resolved: false, staleReason: `keep file was already deleted by a previous cleanup: ${member.keepPath}` };
  }

  const deleteFiles: Array<{ fileId: number; path: string }> = [];
  for (const dp of member.deletePaths) {
    const f = byPath.get(dp);
    if (!f) {
      return { resolved: false, staleReason: `delete path no longer present in latest scan: ${dp}` };
    }
    if (f.full_hash !== member.contentHash) {
      return { resolved: false, staleReason: `delete file hash drifted: ${dp}` };
    }
    if (deletedSet.has(f.id)) {
      return { resolved: false, staleReason: `delete path was already deleted by a previous cleanup: ${dp}` };
    }
    deleteFiles.push({ fileId: f.id, path: f.path });
  }

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
    .get(keep.id, ctx.duplicateJobId, member.contentHash) as { group_id: number } | null;

  if (!groupRow) {
    return { resolved: false, staleReason: "no matching duplicate group in the latest detection" };
  }

  return {
    resolved: true,
    duplicateGroupId: groupRow.group_id,
    keepFile: { fileId: keep.id, path: keep.path },
    deleteFiles,
  };
}

/**
 * Resolves the latest completed duplicate detection job for a disk and
 * returns its id + scan id. Returns `{ duplicateJobId: null, scanId: null }`
 * when no detection has completed yet (suggestions then all resolve stale).
 */
function latestDetectionContext(
  db: ReturnType<typeof getDb>,
  diskId: number
): { duplicateJobId: number | null; scanId: number | null } {
  const row = db
    .prepare(
      `SELECT id, payload_json FROM jobs
       WHERE type = 'duplicate_detection'
         AND target_disk_id = ?
         AND status = 'completed'
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`
    )
    .get(diskId) as { id: number; payload_json: string | null } | null;

  if (!row || !row.payload_json) return { duplicateJobId: null, scanId: null };
  const payload = JSON.parse(row.payload_json) as { scanId?: number };
  if (!Number.isInteger(payload.scanId)) return { duplicateJobId: null, scanId: null };
  return { duplicateJobId: row.id, scanId: payload.scanId as number };
}

// ---------------------------------------------------------------------------
// GET /api/disks/:id/cleanup/suggestions
// List batches. Defaults to status=pending. Each batch resolves its members
// independently against the latest detection. A batch is "actionable" (Apply
// can be enabled) iff status === 'pending' AND every member resolved.
// ---------------------------------------------------------------------------
agentCleanupRouter.get("/suggestions", (c) => {
  const diskId = Number(c.req.param("id"));
  const status = c.req.query("status") ?? "pending";
  const limit  = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Number(c.req.query("offset") ?? 0);

  if (!["pending", "applied", "dismissed", "all"].includes(status)) {
    return c.json({ error: "Invalid status filter" }, 400);
  }

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const ctx = latestDetectionContext(db, diskId);

  const whereStatus = status === "all" ? "" : "AND status = ?";
  const params: Array<number | string> = [diskId];
  if (status !== "all") params.push(status);

  // We sort by total wasted bytes (computed from members) so a large
  // multi-file batch surfaces over a single-file one. SQLite can't order by
  // the JSON length cheaply, so we fetch then sort in JS — counts here are
  // small (page size ≤ 200) so the cost is fine.
  const parents = db
    .prepare(
      `SELECT id, status, rationale, batch_key, created_at, applied_at, dismissed_at
       FROM cleanup_suggestions
       WHERE disk_id = ? ${whereStatus}
       ORDER BY id DESC`
    )
    .all(...params) as Array<{
      id: number;
      status: "pending" | "applied" | "dismissed";
      rationale: string;
      batch_key: string | null;
      created_at: string;
      applied_at: string | null;
      dismissed_at: string | null;
    }>;

  if (parents.length === 0) {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM cleanup_suggestions WHERE disk_id = ? ${whereStatus}`)
      .get(...(status === "all" ? [diskId] : [diskId, status])) as { n: number };
    return c.json({
      diskId,
      duplicateJobId: ctx.duplicateJobId,
      total: total.n,
      limit,
      offset,
      suggestions: [],
    });
  }

  // Fetch all members for this page of parents in one query.
  const parentIds = parents.map((p) => p.id);
  const placeholders = parentIds.map(() => "?").join(", ");
  const memberRows = db
    .prepare(
      `SELECT id, suggestion_id, content_hash, keep_path, delete_paths, size_bytes
       FROM cleanup_suggestion_members
       WHERE suggestion_id IN (${placeholders})
       ORDER BY suggestion_id, id`
    )
    .all(...parentIds) as Array<{
      id: number;
      suggestion_id: number;
      content_hash: string;
      keep_path: string;
      delete_paths: string;
      size_bytes: number;
    }>;

  const membersByParent = new Map<number, typeof memberRows>();
  for (const m of memberRows) {
    if (!membersByParent.has(m.suggestion_id)) membersByParent.set(m.suggestion_id, []);
    membersByParent.get(m.suggestion_id)!.push(m);
  }

  const suggestions = parents.map((p) => {
    const rawMembers = membersByParent.get(p.id) ?? [];
    if (rawMembers.length === 0) {
      throw new Error(`invariant: suggestion ${p.id} has no members`);
    }

    const members = rawMembers.map((m) => {
      const deletePaths = JSON.parse(m.delete_paths) as string[];
      const wastedBytes = m.size_bytes * deletePaths.length;
      const base = {
        id: m.id,
        contentHash: m.content_hash,
        keepPath: m.keep_path,
        deletePaths,
        sizeBytes: m.size_bytes,
        wastedBytes,
      };
      if (p.status !== "pending") {
        return { ...base, resolved: false as const, staleReason: null };
      }
      const resolution = resolveMember(db, ctx, {
        contentHash: m.content_hash,
        keepPath: m.keep_path,
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
      }
      return { ...base, resolved: false as const, staleReason: resolution.staleReason };
    });

    const totalSizeBytes = members.reduce((s, m) => s + m.sizeBytes, 0);
    const totalWastedBytes = members.reduce((s, m) => s + m.wastedBytes, 0);
    const allResolved = members.every((m) => m.resolved);

    return {
      id: p.id,
      status: p.status,
      rationale: p.rationale,
      batchKey: p.batch_key,
      createdAt: p.created_at,
      appliedAt: p.applied_at,
      dismissedAt: p.dismissed_at,
      memberCount: members.length,
      totalSizeBytes,
      totalWastedBytes,
      allResolved: p.status === "pending" ? allResolved : false,
      members,
    };
  });

  // Sort by total wasted bytes desc (with id tiebreaker for stability), then
  // page in JS.
  suggestions.sort((a, b) => {
    if (b.totalWastedBytes !== a.totalWastedBytes) return b.totalWastedBytes - a.totalWastedBytes;
    return b.id - a.id;
  });
  const paged = suggestions.slice(offset, offset + limit);

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM cleanup_suggestions WHERE disk_id = ? ${whereStatus}`)
    .get(...(status === "all" ? [diskId] : [diskId, status])) as { n: number };

  return c.json({
    diskId,
    duplicateJobId: ctx.duplicateJobId,
    total: total.n,
    limit,
    offset,
    suggestions: paged,
  });
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/cleanup/suggestions
// Create a batch. If `batchKey` is provided AND a pending batch already
// exists for (disk, batchKey), the old batch is replaced.
//
// Body:
//   {
//     rationale?: string,
//     batchKey?: string | null,
//     members: [
//       { contentHash: string, keepPath: string, deletePaths: string[], sizeBytes: number }
//     ]
//   }
//
// A singleton batch is just `members: [oneEntry]`.
// ---------------------------------------------------------------------------
interface CreateBatchMember {
  contentHash: string;
  keepPath: string;
  deletePaths: string[];
  sizeBytes: number;
}
interface CreateBatchBody {
  rationale?: string;
  batchKey?: string | null;
  members: CreateBatchMember[];
}

agentCleanupRouter.post("/suggestions", async (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const body = await c.req.json<CreateBatchBody>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (!Array.isArray(body.members) || body.members.length === 0) {
    return c.json({ error: "members must be a non-empty array" }, 400);
  }
  const rationale = typeof body.rationale === "string" ? body.rationale : "";
  const batchKey =
    typeof body.batchKey === "string" && body.batchKey.length > 0 ? body.batchKey : null;

  // Per-member validation. We also enforce content_hash uniqueness within
  // the batch — the DB has a partial unique index, but rejecting here
  // produces a clean 400 instead of a 500 from a constraint failure.
  const seenHashes = new Set<string>();
  for (const m of body.members) {
    if (typeof m.contentHash !== "string" || m.contentHash.length === 0) {
      return c.json({ error: "Every member must include a non-empty contentHash" }, 400);
    }
    if (seenHashes.has(m.contentHash)) {
      return c.json({ error: `Duplicate contentHash within batch: ${m.contentHash}` }, 400);
    }
    seenHashes.add(m.contentHash);
    if (typeof m.keepPath !== "string" || !m.keepPath.startsWith("/")) {
      return c.json({ error: "Every member's keepPath must be an absolute path" }, 400);
    }
    if (!Array.isArray(m.deletePaths) || m.deletePaths.length === 0) {
      return c.json({ error: "Every member's deletePaths must be a non-empty array" }, 400);
    }
    for (const dp of m.deletePaths) {
      if (typeof dp !== "string" || !dp.startsWith("/")) {
        return c.json({ error: "Every deletePaths entry must be an absolute path" }, 400);
      }
      if (dp === m.keepPath) {
        return c.json({ error: "keepPath must not appear in deletePaths" }, 400);
      }
    }
    const dedupedDeletes = Array.from(new Set(m.deletePaths));
    if (dedupedDeletes.length !== m.deletePaths.length) {
      return c.json({ error: "deletePaths contains duplicates within a member" }, 400);
    }
    if (!Number.isFinite(m.sizeBytes) || m.sizeBytes < 0) {
      return c.json({ error: "Every member's sizeBytes must be a non-negative number" }, 400);
    }
  }

  const insertedId = db.transaction(() => {
    if (batchKey !== null) {
      db.prepare(
        `DELETE FROM cleanup_suggestions
         WHERE disk_id = ? AND batch_key = ? AND status = 'pending'`
      ).run(diskId, batchKey);
    }
    const parent = db
      .prepare(
        `INSERT INTO cleanup_suggestions (disk_id, rationale, batch_key)
         VALUES (?, ?, ?) RETURNING id`
      )
      .get(diskId, rationale, batchKey) as { id: number };

    const insertMember = db.prepare(
      `INSERT INTO cleanup_suggestion_members
         (suggestion_id, content_hash, keep_path, delete_paths, size_bytes)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const m of body.members) {
      insertMember.run(
        parent.id,
        m.contentHash,
        m.keepPath,
        JSON.stringify(Array.from(new Set(m.deletePaths))),
        Math.floor(m.sizeBytes)
      );
    }
    return parent.id;
  })();

  return c.json({ id: insertedId, diskId }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/cleanup/suggestions/:id/apply
// Apply a whole pending batch in one shot. Enforces the same browser-UA and
// initiatedFromWebUI guardrails as the manual /duplicates/cleanup endpoint.
// Holds the disk write lock for the duration of the batch and runs each
// member through the shared applyDuplicateCleanup helper.
//
// On any per-member failure (validation or delete error) the batch is halted
// and a 500 is returned with the partial result. Successful members have
// already been persisted to deleted_files. Status of the batch row stays
// `pending` so the user can retry after fixing the underlying issue.
//
// Body: { initiatedFromWebUI: true }
// ---------------------------------------------------------------------------

function isBrowserUserAgent(ua: string | undefined): boolean {
  if (!ua) return false;
  return ua.includes("Mozilla/");
}

agentCleanupRouter.post("/suggestions/:suggestionId/apply", async (c) => {
  const userAgent = c.req.header("User-Agent");
  if (!isBrowserUserAgent(userAgent)) {
    return c.json({ error: "Deletion requests must originate from a web browser" }, 403);
  }
  const body = await c.req.json<{ initiatedFromWebUI?: boolean }>().catch(() => ({} as { initiatedFromWebUI?: boolean }));
  if (body.initiatedFromWebUI !== true) {
    return c.json(
      { error: "Deletion requests must be initiated from the web UI (initiatedFromWebUI must be true)" },
      403
    );
  }

  const diskId = Number(c.req.param("id"));
  const suggestionId = Number(c.req.param("suggestionId"));
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) {
    return c.json({ error: "Invalid suggestionId" }, 400);
  }

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);
  if (!disk.mount_path) {
    return c.json({ error: "Disk is not currently connected" }, 409);
  }

  const parent = db
    .prepare(
      `SELECT id, status FROM cleanup_suggestions WHERE id = ? AND disk_id = ?`
    )
    .get(suggestionId, diskId) as { id: number; status: string } | null;
  if (!parent) {
    return c.json({ error: "Suggestion not found for this disk" }, 404);
  }
  if (parent.status !== "pending") {
    return c.json({ error: `Suggestion is ${parent.status}, not pending` }, 409);
  }

  const rawMembers = db
    .prepare(
      `SELECT id, content_hash, keep_path, delete_paths, size_bytes
       FROM cleanup_suggestion_members
       WHERE suggestion_id = ?
       ORDER BY id`
    )
    .all(suggestionId) as Array<{
      id: number;
      content_hash: string;
      keep_path: string;
      delete_paths: string;
      size_bytes: number;
    }>;
  if (rawMembers.length === 0) {
    throw new Error(`invariant: suggestion ${suggestionId} has no members`);
  }

  // Resolve every member upfront. If even one is stale, refuse the apply
  // before we acquire the lock or touch disk.
  const ctx = latestDetectionContext(db, diskId);
  if (ctx.duplicateJobId === null) {
    return c.json({ error: "No completed duplicate detection for this disk" }, 409);
  }

  const resolvedMembers: Array<{
    memberId: number;
    duplicateGroupId: number;
    keepFile: { fileId: number; path: string };
    deleteFiles: Array<{ fileId: number; path: string }>;
  }> = [];

  for (const m of rawMembers) {
    const deletePaths = JSON.parse(m.delete_paths) as string[];
    const r = resolveMember(db, ctx, {
      contentHash: m.content_hash,
      keepPath: m.keep_path,
      deletePaths,
    });
    if (!r.resolved) {
      return c.json(
        {
          error: `Cannot apply — member ${m.id} is stale: ${r.staleReason}`,
          staleMemberId: m.id,
        },
        409
      );
    }
    resolvedMembers.push({
      memberId: m.id,
      duplicateGroupId: r.duplicateGroupId,
      keepFile: r.keepFile,
      deleteFiles: r.deleteFiles,
    });
  }

  // Lock holder: the latest detection job. One id covers all members.
  const lockManager = getLockManager();
  const release = lockManager.tryAcquire(diskId, ctx.duplicateJobId);
  if (!release) {
    return c.json(
      { error: "Another job is currently writing to this disk; try again when it finishes" },
      409
    );
  }

  const perMemberResults: Array<{
    memberId: number;
    duplicateGroupId: number;
    keepFileId: number;
    deletedCount: number;
    results: Array<{ fileId: number; path: string; status: "deleted" }>;
    failedAt: { fileId: number; path: string; error: string } | null;
  }> = [];
  let haltedAt: { memberId: number; error: string } | null = null;

  try {
    for (const rm of resolvedMembers) {
      let r;
      try {
        r = await applyDuplicateCleanup(
          db,
          { diskId, diskMountPath: disk.mount_path },
          {
            duplicateGroupId: rm.duplicateGroupId,
            keepFile: rm.keepFile,
            deleteFiles: rm.deleteFiles,
          }
        );
      } catch (err) {
        const message = err instanceof CleanupValidationError ? err.message : (err as Error).message;
        haltedAt = { memberId: rm.memberId, error: message };
        break;
      }
      perMemberResults.push({
        memberId: rm.memberId,
        duplicateGroupId: r.duplicateGroupId,
        keepFileId: r.keepFileId,
        deletedCount: r.deletedCount,
        results: r.results,
        failedAt: r.failedAt,
      });
      if (r.failedAt) {
        haltedAt = { memberId: rm.memberId, error: r.failedAt.error };
        break;
      }
    }
  } finally {
    release();
  }

  const totalDeleted = perMemberResults.reduce((s, m) => s + m.deletedCount, 0);
  const jm = getJobManager();

  if (haltedAt) {
    jm.logEvent(
      ctx.duplicateJobId,
      "error",
      "suggestion_apply_halted",
      `Suggestion ${suggestionId} apply halted on member ${haltedAt.memberId}: ${haltedAt.error}`,
      { suggestionId, totalDeleted, haltedAt }
    );
    return c.json(
      {
        error: `Apply halted on member ${haltedAt.memberId}: ${haltedAt.error}`,
        suggestionId,
        totalDeleted,
        members: perMemberResults,
        haltedAt,
      },
      500
    );
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE cleanup_suggestions
     SET status = 'applied', applied_at = ?
     WHERE id = ? AND disk_id = ? AND status = 'pending'`
  ).run(now, suggestionId, diskId);

  jm.logEvent(
    ctx.duplicateJobId,
    "info",
    "suggestion_apply_succeeded",
    `Suggestion ${suggestionId} applied: ${totalDeleted} file${totalDeleted === 1 ? "" : "s"} deleted across ${perMemberResults.length} member${perMemberResults.length === 1 ? "" : "s"}`,
    { suggestionId, totalDeleted, memberCount: perMemberResults.length }
  );

  return c.json({
    suggestionId,
    status: "applied" as const,
    appliedAt: now,
    totalDeleted,
    members: perMemberResults,
  });
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/cleanup/suggestions/:id/dismissed
// Mark a pending batch as dismissed. Kept in the DB for audit.
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
