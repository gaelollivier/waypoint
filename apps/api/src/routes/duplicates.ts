import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { readDirectory, statFile } from "../fs/disk-reads";
import { isExcludedName } from "../lib/excluded-names";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { getLockManager } from "../locks";
import { DuplicateDetectionJobRunner } from "../jobs/duplicates/duplicate-job";
import {
  DirectoryDuplicateCleanupJobRunner,
  type DirectoryDuplicateCleanupPayload,
} from "../jobs/duplicates/directory-cleanup-job";
import {
  applyDuplicateCleanup,
  CleanupValidationError,
} from "../lib/duplicate-cleanup";

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

  // Fetch all file members for this page of groups in one query.
  // LEFT JOIN deleted_files so the UI can grey out files that have already
  // been cleaned up; the join survives a re-run of detection on the same
  // scan because deleted_files is keyed by file_id (scan-snapshot ID).
  const groupIds = groups.map((g) => g.id);
  const filesMap = new Map<number, Array<{ fileId: number; path: string; deletedAt: string | null }>>();

  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(", ");
    const fileRows = db
      .prepare(
        `SELECT dgf.group_id, dgf.file_id, dgf.path, df.deleted_at
         FROM duplicate_group_files dgf
         LEFT JOIN deleted_files df ON df.file_id = dgf.file_id
         WHERE dgf.group_id IN (${placeholders})
         ORDER BY dgf.group_id, dgf.path`
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
      `SELECT id, content_hash, directory_count, total_size_bytes, wasted_bytes, is_eligible_for_cleanup
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
      is_eligible_for_cleanup: number;
    }>;

  // Fetch members for this page of groups, joining deleted_directories so the
  // UI can mark already-cleaned-up copies.
  const groupIds = groups.map((g) => g.id);
  const membersMap = new Map<number, Array<{ directoryId: number; path: string; fileCount: number; deletedAt: string | null }>>();

  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(", ");
    const memberRows = db
      .prepare(
        `SELECT ddgm.group_id, ddgm.directory_id, ddgm.path, d.file_count, dd.deleted_at
         FROM duplicate_directory_group_members ddgm
         JOIN directories d ON d.id = ddgm.directory_id
         LEFT JOIN deleted_directories dd ON dd.directory_id = ddgm.directory_id
         WHERE ddgm.group_id IN (${placeholders})
         ORDER BY ddgm.group_id, ddgm.path`
      )
      .all(...groupIds) as Array<{
        group_id: number;
        directory_id: number;
        path: string;
        file_count: number;
        deleted_at: string | null;
      }>;

    for (const r of memberRows) {
      if (!membersMap.has(r.group_id)) membersMap.set(r.group_id, []);
      membersMap.get(r.group_id)!.push({
        directoryId: r.directory_id,
        path: r.path,
        fileCount: r.file_count,
        deletedAt: r.deleted_at,
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
        canDelete: g.is_eligible_for_cleanup === 1,
        directories: members,
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/duplicates/directories/:groupId/files
// Returns per-member-directory file lists for a directory duplicate group,
// so the cleanup confirmation dialog can render every file the user is
// about to permanently delete and echo the list back to the server.
//
// All members of a directory duplicate group have identical tree structure
// by construction, but their file IDs differ. The response keys files by
// member directory so the UI can render and the cleanup endpoint can match
// the explicit echo against the server's view.
// ---------------------------------------------------------------------------
duplicatesRouter.get("/directories/:groupId/files", (c) => {
  const diskId = Number(c.req.param("id"));
  const groupId = Number(c.req.param("groupId"));
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return c.json({ error: "Invalid groupId" }, 400);
  }

  const db = getDb();

  const group = db
    .prepare(
      `SELECT ddg.id, ddg.duplicate_job_id, ddg.is_eligible_for_cleanup, j.payload_json
       FROM duplicate_directory_groups ddg
       JOIN jobs j ON j.id = ddg.duplicate_job_id
       WHERE ddg.id = ?
         AND j.target_disk_id = ?
         AND j.status = 'completed'`
    )
    .get(groupId, diskId) as {
      id: number;
      duplicate_job_id: number;
      is_eligible_for_cleanup: number;
      payload_json: string | null;
    } | null;

  if (!group) {
    return c.json(
      { error: "Directory duplicate group not found or does not belong to a completed job for this disk" },
      404
    );
  }

  if (!group.payload_json) {
    throw new Error(`invariant: directory group ${groupId} job missing payload_json`);
  }
  const payload = JSON.parse(group.payload_json) as { scanId?: number };
  if (!Number.isInteger(payload.scanId)) {
    throw new Error(`invariant: directory group ${groupId} job payload missing scanId`);
  }
  const scanId = payload.scanId as number;

  const members = db
    .prepare(
      `SELECT directory_id, path FROM duplicate_directory_group_members
       WHERE group_id = ? ORDER BY path`
    )
    .all(groupId) as Array<{ directory_id: number; path: string }>;

  // Walk down from each member directory to collect every descendant file.
  // directories.path is denormalized and unique per (disk_id, path), so we
  // join on the path-prefix relationship using the directory_id chain to
  // stay index-friendly. Concretely: collect each member's descendant
  // directory IDs via recursive walk over parent_id, then SELECT files in
  // a single batched IN-clause per call.
  const childDirs = db.prepare(
    `SELECT id FROM directories WHERE scan_id = ? AND parent_id = ?`
  );

  function collectDescendantDirIds(rootId: number): number[] {
    const ids: number[] = [rootId];
    const queue: number[] = [rootId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = childDirs.all(scanId, parentId) as Array<{ id: number }>;
      for (const c of children) {
        ids.push(c.id);
        queue.push(c.id);
      }
    }
    return ids;
  }

  const filesByMember: Array<{
    directoryId: number;
    path: string;
    files: Array<{ fileId: number; path: string; relativePath: string; sizeBytes: number; hasFullHash: boolean }>;
  }> = [];

  for (const m of members) {
    const dirIds = collectDescendantDirIds(m.directory_id);
    const placeholders = dirIds.map(() => "?").join(", ");
    const fileRows = db
      .prepare(
        `SELECT id, path, size_bytes, full_hash
         FROM files
         WHERE scan_id = ? AND directory_id IN (${placeholders})
         ORDER BY path`
      )
      .all(scanId, ...dirIds) as Array<{ id: number; path: string; size_bytes: number; full_hash: string | null }>;

    // Compute relativePath for the UI confirmation dialog. Member path is
    // the directory's absolute path; relativePath is the suffix beneath it.
    filesByMember.push({
      directoryId: m.directory_id,
      path: m.path,
      files: fileRows.map((f) => ({
        fileId: f.id,
        path: f.path,
        relativePath: f.path.startsWith(m.path + "/")
          ? f.path.slice(m.path.length + 1)
          : f.path,
        sizeBytes: f.size_bytes,
        hasFullHash: f.full_hash != null,
      })),
    });
  }

  return c.json({
    groupId,
    canDelete: group.is_eligible_for_cleanup === 1,
    members: filesByMember,
  });
});

// ---------------------------------------------------------------------------
// GET /api/disks/:id/duplicates/directories/:groupId/inventory
// Live (read-from-disk) inventory of every file inside each member directory
// of a directory duplicate group. Categorizes each on-disk file as:
//   - scanned: matched a scan-recorded file by relative path
//   - excluded: name matches the OS/Waypoint noise-file allowlist
//   - unknown: present on disk but neither scanned nor on the allowlist
// Also reports `missing` files: scan-recorded but no longer on disk.
//
// The cleanup confirmation dialog uses this so the human can see *every*
// file about to be deleted (including .DS_Store noise) before clicking,
// and so we can block confirmation when an `unknown` file is present.
// ---------------------------------------------------------------------------
duplicatesRouter.get("/directories/:groupId/inventory", async (c) => {
  const diskId = Number(c.req.param("id"));
  const groupId = Number(c.req.param("groupId"));
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return c.json({ error: "Invalid groupId" }, 400);
  }

  const db = getDb();

  const group = db
    .prepare(
      `SELECT ddg.id, ddg.duplicate_job_id, ddg.is_eligible_for_cleanup, j.payload_json
       FROM duplicate_directory_groups ddg
       JOIN jobs j ON j.id = ddg.duplicate_job_id
       WHERE ddg.id = ?
         AND j.target_disk_id = ?
         AND j.status = 'completed'`
    )
    .get(groupId, diskId) as {
      id: number;
      duplicate_job_id: number;
      is_eligible_for_cleanup: number;
      payload_json: string | null;
    } | null;

  if (!group) {
    return c.json(
      { error: "Directory duplicate group not found or does not belong to a completed job for this disk" },
      404
    );
  }

  if (!group.payload_json) {
    throw new Error(`invariant: directory group ${groupId} job missing payload_json`);
  }
  const payload = JSON.parse(group.payload_json) as { scanId?: number };
  if (!Number.isInteger(payload.scanId)) {
    throw new Error(`invariant: directory group ${groupId} job payload missing scanId`);
  }
  const scanId = payload.scanId as number;

  const members = db
    .prepare(
      `SELECT directory_id, path FROM duplicate_directory_group_members
       WHERE group_id = ? ORDER BY path`
    )
    .all(groupId) as Array<{ directory_id: number; path: string }>;

  const childDirs = db.prepare(
    `SELECT id FROM directories WHERE scan_id = ? AND parent_id = ?`
  );
  function descendantDirIds(rootId: number): number[] {
    const ids: number[] = [rootId];
    const queue: number[] = [rootId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = childDirs.all(scanId, parentId) as Array<{ id: number }>;
      for (const ch of children) {
        ids.push(ch.id);
        queue.push(ch.id);
      }
    }
    return ids;
  }

  type OnDiskEntry = { relativePath: string; sizeBytes: number };
  /** Returns null if the root directory itself does not exist (ENOENT). */
  async function walkOnDisk(rootAbs: string): Promise<OnDiskEntry[] | null> {
    const out: OnDiskEntry[] = [];
    const queue: Array<{ absDir: string; relDir: string }> = [{ absDir: rootAbs, relDir: "" }];
    let isFirst = true;
    while (queue.length > 0) {
      const { absDir, relDir } = queue.shift()!;
      let entries;
      try {
        entries = await readDirectory(absDir);
      } catch (err: any) {
        if (isFirst && err.code === "ENOENT") return null;
        throw err;
      }
      isFirst = false;
      for (const e of entries) {
        const absChild = path.join(absDir, e.name);
        const relChild = relDir === "" ? e.name : `${relDir}/${e.name}`;
        if (e.isDirectory()) {
          queue.push({ absDir: absChild, relDir: relChild });
        } else if (e.isFile()) {
          const stat = await statFile(absChild);
          out.push({ relativePath: relChild, sizeBytes: stat.size });
        }
        // symlinks / sockets / etc. are intentionally not surfaced — the
        // cleanup loop never deletes them, and the gateways enforce that.
      }
    }
    return out;
  }

  const membersOut = [];
  for (const m of members) {
    const onDisk = await walkOnDisk(m.path);
    if (onDisk === null) {
      membersOut.push({
        directoryId: m.directory_id,
        path: m.path,
        directoryExists: false,
        scanned: [],
        excluded: [],
        unknown: [],
        missing: [],
      });
      continue;
    }

    // Build the scan-recorded view: relativePath → { fileId, sizeBytes, hasFullHash }.
    const dirIds = descendantDirIds(m.directory_id);
    const placeholders = dirIds.map(() => "?").join(", ");
    const scannedRows = db
      .prepare(
        `SELECT id, path, size_bytes, full_hash
         FROM files
         WHERE scan_id = ? AND directory_id IN (${placeholders})`
      )
      .all(scanId, ...dirIds) as Array<{
        id: number;
        path: string;
        size_bytes: number;
        full_hash: string | null;
      }>;

    const scannedByRel = new Map<string, { fileId: number; sizeBytes: number; hasFullHash: boolean }>();
    const prefix = m.path + "/";
    for (const r of scannedRows) {
      if (!r.path.startsWith(prefix)) {
        throw new Error(`invariant: scanned file "${r.path}" is not under member directory "${m.path}"`);
      }
      const rel = r.path.slice(prefix.length);
      scannedByRel.set(rel, {
        fileId: r.id,
        sizeBytes: r.size_bytes,
        hasFullHash: r.full_hash != null,
      });
    }

    const scanned: Array<{ fileId: number; relativePath: string; sizeBytes: number; hasFullHash: boolean }> = [];
    const excluded: Array<{ relativePath: string; sizeBytes: number }> = [];
    const unknown: Array<{ relativePath: string; sizeBytes: number }> = [];
    const seenRel = new Set<string>();

    for (const f of onDisk) {
      seenRel.add(f.relativePath);
      const dbEntry = scannedByRel.get(f.relativePath);
      if (dbEntry) {
        scanned.push({
          fileId: dbEntry.fileId,
          relativePath: f.relativePath,
          sizeBytes: f.sizeBytes,
          hasFullHash: dbEntry.hasFullHash,
        });
      } else if (isExcludedName(path.basename(f.relativePath))) {
        excluded.push({ relativePath: f.relativePath, sizeBytes: f.sizeBytes });
      } else {
        unknown.push({ relativePath: f.relativePath, sizeBytes: f.sizeBytes });
      }
    }

    const missing: Array<{ fileId: number; relativePath: string }> = [];
    for (const [rel, entry] of scannedByRel) {
      if (!seenRel.has(rel)) {
        missing.push({ fileId: entry.fileId, relativePath: rel });
      }
    }

    membersOut.push({
      directoryId: m.directory_id,
      path: m.path,
      directoryExists: true,
      scanned,
      excluded,
      unknown,
      missing,
    });
  }

  return c.json({
    groupId,
    canDelete: group.is_eligible_for_cleanup === 1,
    members: membersOut,
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
// See AGENTS.md "RULE: File deletions must NEVER be initiated by an LLM or agent".
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

  const userAgent = c.req.header("User-Agent");
  if (!isBrowserUserAgent(userAgent)) {
    return c.json({ error: "Deletion requests must originate from a web browser" }, 403);
  }

  const body = await c.req.json<CleanupRequestBody>();
  if (body.initiatedFromWebUI !== true) {
    return c.json(
      { error: "Deletion requests must be initiated from the web UI (initiatedFromWebUI must be true)" },
      403
    );
  }

  const diskId = Number(c.req.param("id"));
  const { duplicateGroupId, keepFile, deleteFiles } = body;

  const db = getDb();

  // ---- Disk validation ----

  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);
  if (!disk.mount_path) {
    return c.json({ error: "Disk is not currently connected" }, 409);
  }

  // Look up the group's owning detection job up front so we can use its id
  // as the disk-lock holder. The lock FKs to jobs(id); the detection job
  // (completed status is fine for FK targeting) is a stable identity for
  // the duration of this cleanup. The helper re-validates the group fully
  // before any disk write.
  const ownerRow = db
    .prepare(
      `SELECT dg.duplicate_job_id
       FROM duplicate_groups dg
       JOIN jobs j ON j.id = dg.duplicate_job_id
       WHERE dg.id = ?
         AND j.target_disk_id = ?
         AND j.status = 'completed'`
    )
    .get(duplicateGroupId, diskId) as { duplicate_job_id: number } | null;
  if (!ownerRow) {
    return c.json(
      { error: "Duplicate group not found or does not belong to a completed job for this disk" },
      404
    );
  }
  const lockHolderJobId = ownerRow.duplicate_job_id;

  // ---- Acquire lock, then run shared cleanup ----

  const lockManager = getLockManager();
  const release = lockManager.tryAcquire(diskId, lockHolderJobId);
  if (!release) {
    return c.json(
      { error: "Another job is currently writing to this disk; try again when it finishes" },
      409
    );
  }

  let result;
  try {
    result = await applyDuplicateCleanup(
      db,
      { diskId, diskMountPath: disk.mount_path },
      { duplicateGroupId, keepFile, deleteFiles }
    );
  } catch (err) {
    if (err instanceof CleanupValidationError) {
      release();
      return c.json({ error: err.message }, err.status as 400 | 404 | 409);
    }
    release();
    throw err;
  }
  release();

  const jm = getJobManager();
  if (result.failedAt) {
    jm.logEvent(
      lockHolderJobId,
      "error",
      "duplicate_cleanup_halted",
      `File cleanup halted after ${result.deletedCount}/${deleteFiles.length} deletion${deleteFiles.length === 1 ? "" : "s"}: ${result.failedAt.error}`,
      { duplicateGroupId, keepFileId: keepFile.fileId, deletedCount: result.deletedCount, failedAt: result.failedAt }
    );
    return c.json(
      {
        error: `Cleanup halted: ${result.failedAt.error}`,
        duplicateGroupId,
        keepFileId: keepFile.fileId,
        deletedCount: result.deletedCount,
        results: result.results,
        failedAt: result.failedAt,
      },
      500
    );
  }

  jm.logEvent(
    lockHolderJobId,
    "info",
    "duplicate_cleanup_succeeded",
    `Deleted ${result.deletedCount} duplicate file${result.deletedCount === 1 ? "" : "s"} (keeping ${keepFile.path})`,
    { duplicateGroupId, keepFileId: keepFile.fileId, deletedCount: result.deletedCount }
  );

  return c.json({
    duplicateGroupId,
    keepFileId: keepFile.fileId,
    deletedCount: result.deletedCount,
    results: result.results,
  });
});

// ---------------------------------------------------------------------------
// POST /api/disks/:id/duplicates/directories/cleanup
// Delete every file inside one or more "delete" copies of a directory
// duplicate group, keeping the chosen "keep" copy. Same anti-automation
// guardrails as the file-level cleanup endpoint. Runs as a background job
// because a single delete folder can hold thousands of files.
// ---------------------------------------------------------------------------

interface DirectoryCleanupRequestBody {
  initiatedFromWebUI: boolean;
  duplicateDirectoryGroupId: number;
  keepDirectory: { directoryId: number; path: string };
  deleteDirectories: Array<{
    directoryId: number;
    path: string;
    files: Array<{ fileId: number; relativePath: string }>;
    excludedFiles?: Array<{ relativePath: string }>;
  }>;
}

duplicatesRouter.post("/directories/cleanup", async (c) => {
  // ---- Anti-automation guardrails ----

  const userAgent = c.req.header("User-Agent");
  if (!isBrowserUserAgent(userAgent)) {
    return c.json(
      { error: "Deletion requests must originate from a web browser" },
      403
    );
  }

  const body = await c.req.json<DirectoryCleanupRequestBody>();
  if (body.initiatedFromWebUI !== true) {
    return c.json(
      { error: "Deletion requests must be initiated from the web UI (initiatedFromWebUI must be true)" },
      403
    );
  }

  // ---- Input validation ----

  const diskId = Number(c.req.param("id"));
  const { duplicateDirectoryGroupId, keepDirectory, deleteDirectories } = body;

  if (!Number.isInteger(duplicateDirectoryGroupId) || duplicateDirectoryGroupId <= 0) {
    return c.json({ error: "Invalid duplicateDirectoryGroupId" }, 400);
  }
  if (
    !keepDirectory ||
    !Number.isInteger(keepDirectory.directoryId) ||
    keepDirectory.directoryId <= 0 ||
    typeof keepDirectory.path !== "string"
  ) {
    return c.json({ error: "Invalid keepDirectory — must include directoryId and path" }, 400);
  }
  if (!Array.isArray(deleteDirectories) || deleteDirectories.length === 0) {
    return c.json({ error: "deleteDirectories must be a non-empty array" }, 400);
  }
  const keepId = keepDirectory.directoryId;
  for (const d of deleteDirectories) {
    if (
      !Number.isInteger(d.directoryId) || d.directoryId <= 0 ||
      typeof d.path !== "string" ||
      !Array.isArray(d.files)
    ) {
      return c.json({ error: "All deleteDirectories entries must include directoryId, path, files[]" }, 400);
    }
    if (d.directoryId === keepId) {
      return c.json({ error: "keepDirectory must not appear in deleteDirectories" }, 400);
    }
    for (const f of d.files) {
      if (!Number.isInteger(f.fileId) || f.fileId <= 0 || typeof f.relativePath !== "string") {
        return c.json({ error: "All file echoes must include fileId and relativePath" }, 400);
      }
    }
    if (d.excludedFiles !== undefined) {
      if (!Array.isArray(d.excludedFiles)) {
        return c.json({ error: "excludedFiles must be an array when provided" }, 400);
      }
      for (const ef of d.excludedFiles) {
        if (typeof ef.relativePath !== "string" || ef.relativePath.length === 0) {
          return c.json({ error: "All excludedFiles entries must include a non-empty relativePath" }, 400);
        }
        // Guard against path traversal and against names not on the noise
        // allowlist. The gateway re-checks the basename, but rejecting here
        // produces a cleaner 400 instead of letting the job fail mid-run.
        if (ef.relativePath.includes("..") || path.isAbsolute(ef.relativePath)) {
          return c.json({ error: `excludedFiles relativePath "${ef.relativePath}" must be a relative, in-tree path` }, 400);
        }
        if (!isExcludedName(path.basename(ef.relativePath))) {
          return c.json(
            { error: `excludedFiles entry "${ef.relativePath}" is not on the noise-file allowlist` },
            400
          );
        }
      }
    }
  }

  const db = getDb();

  // ---- Disk validation ----

  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);
  if (!disk.mount_path) {
    return c.json({ error: "Disk is not currently connected" }, 409);
  }

  // ---- Group validation ----

  const group = db
    .prepare(
      `SELECT ddg.id, ddg.duplicate_job_id, ddg.is_eligible_for_cleanup,
              ddg.directory_count, j.payload_json
       FROM duplicate_directory_groups ddg
       JOIN jobs j ON j.id = ddg.duplicate_job_id
       WHERE ddg.id = ?
         AND j.target_disk_id = ?
         AND j.status = 'completed'`
    )
    .get(duplicateDirectoryGroupId, diskId) as {
      id: number;
      duplicate_job_id: number;
      is_eligible_for_cleanup: number;
      directory_count: number;
      payload_json: string | null;
    } | null;

  if (!group) {
    return c.json(
      { error: "Directory duplicate group not found or does not belong to a completed job for this disk" },
      404
    );
  }
  if (group.is_eligible_for_cleanup !== 1) {
    return c.json(
      { error: "This directory group is not eligible for cleanup — every file must have full_hash. Run a fullHash scan first." },
      409
    );
  }
  if (deleteDirectories.length >= group.directory_count) {
    return c.json(
      { error: "Cannot delete all copies — at least one must remain" },
      400
    );
  }

  if (!group.payload_json) {
    throw new Error(`invariant: directory group ${duplicateDirectoryGroupId} job missing payload_json`);
  }
  const groupPayload = JSON.parse(group.payload_json) as { scanId?: number };
  if (!Number.isInteger(groupPayload.scanId)) {
    throw new Error(`invariant: directory group ${duplicateDirectoryGroupId} job payload missing scanId`);
  }
  const scanId = groupPayload.scanId as number;

  // ---- Member validation: every referenced directory belongs to the group ----

  const memberRows = db
    .prepare(
      `SELECT directory_id, path FROM duplicate_directory_group_members WHERE group_id = ?`
    )
    .all(duplicateDirectoryGroupId) as Array<{ directory_id: number; path: string }>;
  const memberByDirId = new Map(memberRows.map((m) => [m.directory_id, m]));

  const keepMember = memberByDirId.get(keepDirectory.directoryId);
  if (!keepMember) {
    return c.json(
      { error: `keepDirectory ${keepDirectory.directoryId} is not a member of group ${duplicateDirectoryGroupId}` },
      400
    );
  }
  if (keepMember.path !== keepDirectory.path) {
    return c.json(
      { error: `Path mismatch for keepDirectory: UI sent "${keepDirectory.path}" but DB has "${keepMember.path}"` },
      409
    );
  }

  for (const d of deleteDirectories) {
    const member = memberByDirId.get(d.directoryId);
    if (!member) {
      return c.json(
        { error: `deleteDirectory ${d.directoryId} is not a member of group ${duplicateDirectoryGroupId}` },
        400
      );
    }
    if (member.path !== d.path) {
      return c.json(
        { error: `Path mismatch for delete directory ${d.directoryId}: UI sent "${d.path}" but DB has "${member.path}"` },
        409
      );
    }
  }

  // ---- File-id ownership: every echoed fileId must be a scan-recorded file
  //      under the corresponding delete directory ----

  for (const d of deleteDirectories) {
    if (d.files.length === 0) {
      return c.json(
        { error: `deleteDirectory ${d.directoryId} has no files to delete — refusing` },
        400
      );
    }
    const placeholders = d.files.map(() => "?").join(", ");
    const fileIds = d.files.map((f) => f.fileId);
    const rows = db
      .prepare(
        `SELECT id, path FROM files
         WHERE scan_id = ? AND id IN (${placeholders})`
      )
      .all(scanId, ...fileIds) as Array<{ id: number; path: string }>;
    if (rows.length !== fileIds.length) {
      return c.json(
        { error: `Some echoed fileIds for delete directory ${d.directoryId} are not in the scan` },
        400
      );
    }
    for (const r of rows) {
      const dirPrefix = d.path + "/";
      if (!r.path.startsWith(dirPrefix)) {
        return c.json(
          { error: `File ${r.id} (${r.path}) is not under delete directory ${d.path}` },
          400
        );
      }
    }
  }

  // ---- Active-job guard: only one cleanup per group at a time ----

  const activeCleanup = db
    .prepare(
      `SELECT id FROM jobs
       WHERE type = 'directory_duplicate_cleanup'
         AND target_disk_id = ?
         AND status IN ('queued', 'running', 'paused')
       LIMIT 1`
    )
    .get(diskId);
  if (activeCleanup) {
    return c.json(
      { error: "A directory cleanup job is already active for this disk" },
      409
    );
  }

  // ---- Disk write lock: fail-fast if another writer holds it ----
  //
  // We don't acquire here — the job runner does that for the duration of its
  // execute(). This check just rejects the request quickly when a copy or
  // other writer is already running on the disk, rather than spawning a job
  // that would immediately block on acquire().
  const lockState = getLockManager().getState(diskId);
  if (lockState) {
    return c.json(
      { error: "Another job is currently writing to this disk; try again when it finishes" },
      409
    );
  }

  // ---- Create + start the job ----

  const payload: DirectoryDuplicateCleanupPayload = {
    duplicateDirectoryGroupId,
    keepDirectory,
    deleteDirectories,
  };

  const jm = getJobManager();
  const job = jm.createJob({
    type: "directory_duplicate_cleanup",
    targetDiskId: diskId,
    payload,
  });

  const runner = new DirectoryDuplicateCleanupJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    diskId,
    diskMountPath: disk.mount_path,
    scanId,
    payload,
  });

  registerRunner(job.id, runner);
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});
