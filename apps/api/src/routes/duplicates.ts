import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { statFile } from "../fs/disk-reads";
import { deleteDuplicateFile } from "../fs/disk-writes";
import { computeSampledHash } from "../jobs/scan/hasher";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { DuplicateDetectionJobRunner } from "../jobs/duplicates/duplicate-job";

export const duplicatesRouter = new Hono();

// ---------------------------------------------------------------------------
// POST /api/disks/:id/duplicates
// Start a duplicate detection job for this disk.
// Body (optional): { scanId?: number } — defaults to the latest completed scan.
// ---------------------------------------------------------------------------
duplicatesRouter.post("/", async (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();

  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const body = await c.req.json<{ scanId?: number }>().catch(() => ({} as { scanId?: number }));

  // Disk must have been scanned
  if (!disk.last_scan_job_id) {
    return c.json({ error: "Disk has no scan data — run a scan first" }, 409);
  }

  const scanId = body.scanId ?? disk.last_scan_job_id;
  if (!Number.isInteger(scanId) || scanId <= 0) {
    return c.json({ error: "Invalid scanId" }, 400);
  }

  const scanJob = db
    .prepare(
      `SELECT id FROM jobs
       WHERE id = ?
         AND type = 'scan'
         AND target_disk_id = ?
         AND status = 'completed'`
    )
    .get(scanId, diskId);
  if (!scanJob) {
    return c.json({ error: "Scan not found or does not belong to this disk" }, 404);
  }

  // Verify the scan has files with hashes
  const hashCount = db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE scan_id = ? AND sampled_hash IS NOT NULL")
    .get(scanId) as { n: number };
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
    payload: { scanId },
  });

  const runner = new DuplicateDetectionJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    diskId,
    scanId,
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
      `SELECT id, hash_kind, content_hash, sampled_hash, file_count, size_bytes, wasted_bytes
       FROM duplicate_groups dg
       WHERE dg.duplicate_job_id = ?
         AND dg.size_bytes >= ?
         AND dg.file_count >= ?
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`
    )
    .all(duplicateJobId, minSize, minCopies, limit, offset) as Array<{
      id: number;
      hash_kind: "full" | "sampled";
      content_hash: string;
      sampled_hash: string;
      file_count: number;
      size_bytes: number;
      wasted_bytes: number;
    }>;

  // Fetch all file members for this page of groups in one query
  const groupIds = groups.map((g) => g.id);
  const filesMap = new Map<number, Array<{ fileId: number; path: string; deletedAt: string | null }>>();

  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(", ");
    const fileRows = db
      .prepare(
        `SELECT group_id, file_id, path, deleted_at
         FROM duplicate_group_files
         WHERE group_id IN (${placeholders})
         ORDER BY group_id, path`
      )
      .all(...groupIds) as Array<{ group_id: number; file_id: number; path: string; deleted_at: string | null }>;

    for (const r of fileRows) {
      if (!filesMap.has(r.group_id)) filesMap.set(r.group_id, []);
      filesMap.get(r.group_id)!.push({ fileId: r.file_id, path: r.path, deletedAt: r.deleted_at });
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
      hashKind: g.hash_kind,
      contentHash: g.content_hash,
      sampledHash: g.sampled_hash,
      canDelete: g.hash_kind === "full",
      fileCount: g.file_count,
      sizeBytes: g.size_bytes,
      wastedBytes: g.wasted_bytes,
      files: filesMap.get(g.id) ?? [],
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/duplicates/directories
// Browse directory-level duplicate detection results for this disk.
// Query params:
//   duplicateJobId — defaults to latest completed job for this disk
//   sort           — 'wasted' (default) | 'total_size' | 'directory_count'
//   minSize        — minimum total_size_bytes (default 0)
//   limit          — default 50, max 200
//   offset         — default 0
// ---------------------------------------------------------------------------
duplicatesRouter.get("/directories", (c) => {
  const diskId = Number(c.req.param("id"));
  const rawJobId = c.req.query("duplicateJobId");
  const sort     = c.req.query("sort") ?? "wasted";
  const minSize  = Number(c.req.query("minSize") ?? 0);
  const limit    = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset   = Number(c.req.query("offset") ?? 0);

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

  // Build ORDER BY
  // file_count sort requires a subquery since file_count lives in directories
  const orderBy: Record<string, string> = {
    wasted:          "ddg.wasted_bytes DESC",
    total_size:      "ddg.total_size_bytes DESC",
    directory_count: "ddg.directory_count DESC",
    file_count:      `(SELECT MIN(d.file_count)
                       FROM duplicate_directory_group_members m
                       JOIN directories d ON d.id = m.directory_id
                       WHERE m.group_id = ddg.id) DESC`,
  };
  const orderClause = orderBy[sort] ?? orderBy.wasted;

  // Fetch one page of groups
  const groups = db
    .prepare(
      `SELECT id, content_hash, directory_count, total_size_bytes, wasted_bytes
       FROM duplicate_directory_groups ddg
       WHERE ddg.duplicate_job_id = ?
         AND ddg.total_size_bytes >= ?
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`
    )
    .all(duplicateJobId, minSize, limit, offset) as Array<{
      id: number;
      content_hash: string;
      directory_count: number;
      total_size_bytes: number;
      wasted_bytes: number;
    }>;

  // Fetch members for this page of groups
  const groupIds = groups.map((g) => g.id);
  const membersMap = new Map<number, Array<{ directoryId: number; path: string; fileCount: number }>>();

  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(", ");
    const memberRows = db
      .prepare(
        `SELECT ddgm.group_id, ddgm.directory_id, ddgm.path, d.file_count
         FROM duplicate_directory_group_members ddgm
         JOIN directories d ON d.id = ddgm.directory_id
         WHERE ddgm.group_id IN (${placeholders})
         ORDER BY ddgm.group_id, ddgm.path`
      )
      .all(...groupIds) as Array<{
        group_id: number;
        directory_id: number;
        path: string;
        file_count: number;
      }>;

    for (const r of memberRows) {
      if (!membersMap.has(r.group_id)) membersMap.set(r.group_id, []);
      membersMap.get(r.group_id)!.push({
        directoryId: r.directory_id,
        path: r.path,
        fileCount: r.file_count,
      });
    }
  }

  // Totals (including aggregate file count across all directory groups)
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total_groups,
         COALESCE(SUM(wasted_bytes), 0) AS total_wasted_bytes,
         COALESCE(SUM(sub.file_count), 0) AS total_file_count
       FROM duplicate_directory_groups ddg
       LEFT JOIN (
         SELECT ddgm.group_id, MIN(d.file_count) AS file_count
         FROM duplicate_directory_group_members ddgm
         JOIN directories d ON d.id = ddgm.directory_id
         GROUP BY ddgm.group_id
       ) sub ON sub.group_id = ddg.id
       WHERE ddg.duplicate_job_id = ?
         AND ddg.total_size_bytes >= ?`
    )
    .get(duplicateJobId, minSize) as { total_groups: number; total_wasted_bytes: number; total_file_count: number };

  return c.json({
    duplicateJobId,
    diskId,
    totalGroups: totals.total_groups,
    totalWastedBytes: totals.total_wasted_bytes,
    totalFileCount: totals.total_file_count,
    groups: groups.map((g) => {
      const members = membersMap.get(g.id) ?? [];
      // All directories in a group are identical, so file count is the same
      // for every member — take the first one.
      const fileCount = members.length > 0 ? members[0].fileCount : 0;
      return {
        id: g.id,
        contentHash: g.content_hash,
        directoryCount: g.directory_count,
        fileCount,
        totalSizeBytes: g.total_size_bytes,
        wastedBytes: g.wasted_bytes,
        directories: members,
      };
    }),
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
      `SELECT id, status, target_disk_id, payload_json, items_processed, created_at, completed_at
       FROM jobs
       WHERE type = 'duplicate_detection' AND target_disk_id = ?
       ORDER BY id DESC
       LIMIT 50`
    )
    .all(diskId) as Array<{
      id: number;
      status: string;
      target_disk_id: number;
      payload_json: string | null;
      items_processed: number;
      created_at: string;
      completed_at: string | null;
    }>;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      diskId: r.target_disk_id,
      scanId: (() => {
        if (!r.payload_json) return null;
        const payload = JSON.parse(r.payload_json) as { scanId?: number };
        return Number.isInteger(payload.scanId) ? payload.scanId as number : null;
      })(),
      itemsProcessed: r.items_processed,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }))
  );
});


// ---------------------------------------------------------------------------
// GET /api/disks/:id/duplicates/scans
// List completed scans available as duplicate-detection inputs.
// ---------------------------------------------------------------------------
duplicatesRouter.get("/scans", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT j.id,
              j.created_at,
              j.completed_at,
              COALESCE(json_extract(j.payload_json, '$.fullHash'), 0) AS requested_full_hash,
              COUNT(f.id) AS file_count,
              COUNT(f.sampled_hash) AS sampled_hash_count,
              COUNT(f.full_hash) AS full_hash_count
       FROM jobs j
       LEFT JOIN files f ON f.scan_id = j.id
       WHERE j.type = 'scan'
         AND j.target_disk_id = ?
         AND j.status = 'completed'
       GROUP BY j.id
       ORDER BY j.id DESC
       LIMIT 50`
    )
    .all(diskId) as Array<{
      id: number;
      created_at: string;
      completed_at: string | null;
      requested_full_hash: number;
      file_count: number;
      sampled_hash_count: number;
      full_hash_count: number;
    }>;

  return c.json(rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    requestedFullHash: r.requested_full_hash === 1,
    fileCount: r.file_count,
    sampledHashCount: r.sampled_hash_count,
    fullHashCount: r.full_hash_count,
    hasAnyFullHashes: r.full_hash_count > 0,
    hasAllFullHashes: r.file_count > 0 && r.full_hash_count === r.file_count,
  })));
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/duplicates/cleanup
// Delete duplicate files, keeping the specified copy.
//
// SAFETY: This endpoint permanently deletes files. It enforces multiple
// guardrails to ensure deletions are only triggered by a human via the web UI.
// See CLAUDE.md "RULE: File deletions must NEVER be initiated by an LLM or agent".
// ---------------------------------------------------------------------------

/** Rejects user agents that don't look like a real browser. */
function isBrowserUserAgent(ua: string | undefined): boolean {
  if (!ua) return false;
  // Real browsers include "Mozilla/" in their UA string.
  // This rejects curl, httpie, python-requests, node-fetch, SDK clients, etc.
  return ua.includes("Mozilla/");
}

interface CleanupRequestBody {
  initiatedFromWebUI: boolean;
  duplicateGroupId: number;
  keepFile: { fileId: number; path: string };
  deleteFiles: Array<{ fileId: number; path: string }>;
}

duplicatesRouter.post("/cleanup", async (c) => {
  // ---- Anti-automation guardrails ----

  // 1. User-Agent must look like a real browser
  const userAgent = c.req.header("User-Agent");
  if (!isBrowserUserAgent(userAgent)) {
    return c.json(
      { error: "Deletion requests must originate from a web browser" },
      403
    );
  }

  // 2. Body must include the explicit web-UI flag
  const body = await c.req.json<CleanupRequestBody>();
  if (body.initiatedFromWebUI !== true) {
    return c.json(
      { error: "Deletion requests must be initiated from the web UI (initiatedFromWebUI must be true)" },
      403
    );
  }

  // ---- Input validation ----

  const diskId = Number(c.req.param("id"));
  const { duplicateGroupId, keepFile, deleteFiles } = body;

  if (!Number.isInteger(duplicateGroupId) || duplicateGroupId <= 0) {
    return c.json({ error: "Invalid duplicateGroupId" }, 400);
  }
  if (!keepFile || !Number.isInteger(keepFile.fileId) || keepFile.fileId <= 0 || typeof keepFile.path !== "string") {
    return c.json({ error: "Invalid keepFile — must include fileId and path" }, 400);
  }
  if (!Array.isArray(deleteFiles) || deleteFiles.length === 0) {
    return c.json({ error: "deleteFiles must be a non-empty array" }, 400);
  }
  if (deleteFiles.some((f) => !Number.isInteger(f.fileId) || f.fileId <= 0 || typeof f.path !== "string")) {
    return c.json({ error: "All deleteFiles entries must include fileId and path" }, 400);
  }

  const keepFileId = keepFile.fileId;
  const deleteFileIds = deleteFiles.map((f) => f.fileId);

  // The file to keep must not appear in the delete list
  if (deleteFileIds.includes(keepFileId)) {
    return c.json({ error: "keepFile must not appear in deleteFiles" }, 400);
  }

  const db = getDb();

  // ---- Disk validation ----

  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);
  if (!disk.mount_path) {
    return c.json({ error: "Disk is not currently connected" }, 409);
  }

  // ---- Duplicate group validation ----

  // Verify the group exists and belongs to a completed job for this disk
  const group = db
    .prepare(
      `SELECT dg.id, dg.hash_kind, dg.content_hash, dg.sampled_hash, dg.file_count,
              j.payload_json
       FROM duplicate_groups dg
       JOIN jobs j ON j.id = dg.duplicate_job_id
       WHERE dg.id = ?
         AND j.target_disk_id = ?
         AND j.status = 'completed'`
    )
    .get(duplicateGroupId, diskId) as {
      id: number;
      hash_kind: "full" | "sampled";
      content_hash: string;
      sampled_hash: string;
      file_count: number;
      payload_json: string | null;
    } | null;

  if (!group) {
    return c.json(
      { error: "Duplicate group not found or does not belong to a completed job for this disk" },
      404
    );
  }

  if (group.hash_kind !== "full") {
    return c.json(
      { error: "Duplicate cleanup requires full-hash-backed duplicate groups" },
      409
    );
  }

  if (!group.payload_json) {
    throw new Error(`invariant: duplicate group ${duplicateGroupId} job missing payload_json`);
  }
  const duplicateJobPayload = JSON.parse(group.payload_json) as { scanId?: number };
  if (!Number.isInteger(duplicateJobPayload.scanId)) {
    throw new Error(`invariant: duplicate group ${duplicateGroupId} job payload missing scanId`);
  }
  const selectedScanId = duplicateJobPayload.scanId as number;

  // Verify ALL referenced file IDs (keep + delete) belong to this group
  const allFileIds = [keepFileId, ...deleteFileIds];
  const placeholders = allFileIds.map(() => "?").join(", ");
  const groupFiles = db
    .prepare(
      `SELECT dgf.file_id, dgf.path, f.scan_id, f.sampled_hash, f.full_hash, f.size_bytes
       FROM duplicate_group_files dgf
       JOIN files f ON f.id = dgf.file_id
       WHERE dgf.group_id = ? AND dgf.file_id IN (${placeholders})`
    )
    .all(duplicateGroupId, ...allFileIds) as Array<{
      file_id: number;
      path: string;
      scan_id: number;
      sampled_hash: string | null;
      full_hash: string | null;
      size_bytes: number;
    }>;

  const fileMap = new Map(groupFiles.map((f) => [f.file_id, f]));

  // Every referenced file must belong to this group
  for (const fileId of allFileIds) {
    if (!fileMap.has(fileId)) {
      return c.json(
        { error: `File ${fileId} is not a member of duplicate group ${duplicateGroupId}` },
        400
      );
    }
  }

  // Verify that the paths sent by the frontend match the paths in the DB.
  // The human reviewed these exact paths in the confirmation dialog — if they
  // don't match what the DB has, something is wrong and we must not proceed.
  const sentFiles = [keepFile, ...deleteFiles];
  for (const sent of sentFiles) {
    const dbFile = fileMap.get(sent.fileId);
    if (!dbFile) throw new Error(`invariant: file ${sent.fileId} disappeared from fileMap after validation`);
    if (dbFile.path !== sent.path) {
      return c.json(
        { error: `Path mismatch for file ${sent.fileId}: UI sent "${sent.path}" but DB has "${dbFile.path}"` },
        409
      );
    }
  }

  for (const file of groupFiles) {
    if (file.scan_id !== selectedScanId) {
      throw new Error(
        `invariant: duplicate group ${duplicateGroupId} contains file ${file.file_id} from scan ${file.scan_id}, expected ${selectedScanId}`
      );
    }
    if (file.full_hash !== group.content_hash) {
      return c.json(
        { error: `Stored full hash mismatch for file ${file.file_id}; refusing to delete` },
        409
      );
    }
    if (file.sampled_hash == null) {
      throw new Error(`invariant: full-hash duplicate file ${file.file_id} is missing sampled_hash`);
    }
  }

  // After deletion, at least one copy must remain (the keep file)
  // This is already guaranteed by the keepFileId not being in deleteFileIds,
  // but verify the group has enough members
  if (deleteFileIds.length >= group.file_count) {
    return c.json(
      { error: "Cannot delete all copies — at least one must remain" },
      400
    );
  }

  // ---- Re-check selected-scan freshness on disk ----

  // Paths in duplicate_group_files are absolute (written by the scan job),
  // so we use them directly — no mount_path prefix needed.
  const currentSamples = new Map<number, string>();
  for (const fileId of allFileIds) {
    const file = fileMap.get(fileId);
    if (!file) throw new Error(`invariant: file ${fileId} disappeared from fileMap before recheck`);

    try {
      const currentStat = await statFile(file.path);
      const currentSampledHash = await computeSampledHash(file.path, currentStat.size);
      currentSamples.set(fileId, currentSampledHash);
      if (currentSampledHash !== file.sampled_hash) {
        return c.json(
          { error: `File ${fileId} no longer matches the selected scan; rerun duplicate detection before deleting` },
          409
        );
      }
    } catch (err: any) {
      return c.json(
        { error: `Could not re-check file ${fileId} before deletion: ${err.message}` },
        409
      );
    }
  }

  // ---- Execute deletions one by one ----

  const keepRecord = fileMap.get(keepFileId);
  if (!keepRecord) throw new Error(`invariant: keep file ${keepFileId} missing before deletion`);
  const keepActualSampledHash = currentSamples.get(keepFileId);
  if (!keepActualSampledHash) throw new Error(`invariant: keep file ${keepFileId} missing recomputed sampled hash`);

  const results: Array<{
    fileId: number;
    path: string;
    status: "deleted" | "error";
    error?: string;
  }> = [];

  for (const fileId of deleteFileIds) {
    const deleteRecord = fileMap.get(fileId);
    if (!deleteRecord) throw new Error(`invariant: delete file ${fileId} missing before deletion`);
    const deleteActualSampledHash = currentSamples.get(fileId);
    if (!deleteActualSampledHash) throw new Error(`invariant: delete file ${fileId} missing recomputed sampled hash`);

    try {
      await deleteDuplicateFile({
        deletePath: deleteRecord.path,
        keepPath: keepRecord.path,
        diskMountPath: disk.mount_path,
        expectedFullHash: group.content_hash,
        deleteFullHash: deleteRecord.full_hash!,
        keepFullHash: keepRecord.full_hash!,
        deleteExpectedSampledHash: deleteRecord.sampled_hash!,
        keepExpectedSampledHash: keepRecord.sampled_hash!,
        deleteActualSampledHash,
        keepActualSampledHash,
      });
      results.push({ fileId, path: deleteRecord.path, status: "deleted" });
    } catch (err: any) {
      results.push({
        fileId,
        path: deleteRecord.path,
        status: "error",
        error: err.message,
      });
    }
  }

  // Mark successfully deleted files in the DB so the UI reflects cleanup progress
  const successfullyDeleted = results.filter((r) => r.status === "deleted");
  if (successfullyDeleted.length > 0) {
    const now = new Date().toISOString();
    const markDeleted = db.prepare(
      "UPDATE duplicate_group_files SET deleted_at = ? WHERE group_id = ? AND file_id = ?"
    );
    db.transaction(() => {
      for (const r of successfullyDeleted) {
        markDeleted.run(now, duplicateGroupId, r.fileId);
      }
    })();
  }

  const deletedCount = successfullyDeleted.length;
  const errorCount = results.filter((r) => r.status === "error").length;

  return c.json({
    duplicateGroupId,
    keepFileId,
    deletedCount,
    errorCount,
    results,
  });
});
