import type { Database } from "bun:sqlite";
import path from "path";
import { computeSampledHash, HASH_ALGO_VERSION } from "./hasher";
import type { JobManager } from "../job-manager";

// SF_DATALESS flag — macOS iCloud stub files that haven't been downloaded.
// Reading them would trigger a network fetch. Detect and skip.
const SF_DATALESS = 0x40000000;

const BATCH_SIZE = 500; // rows per transaction

export interface WalkQueueRow {
  id: number;
  path: string;
  parent_directory_id: number | null;
  status: "pending" | "in_progress" | "done" | "error";
}

/**
 * Pops the next pending directory from scan_walk_queue and processes it:
 *   1. Marks it in_progress
 *   2. Reads directory entries
 *   3. Upserts directory + file rows into the DB
 *   4. Enqueues subdirectories
 *   5. Marks it done
 *
 * Returns the number of files indexed, or null if the queue is empty.
 * Throws on fatal I/O errors; logs non-fatal ones (permission denied) via jobManager.
 */
export async function processNextQueueEntry(
  db: Database,
  scanJobId: number,
  diskId: number,
  jobManager: JobManager
): Promise<{ filesIndexed: number; bytesIndexed: number } | null> {
  // Pop next pending entry atomically
  const entry = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, path, parent_directory_id
         FROM scan_walk_queue
         WHERE scan_job_id = ? AND status = 'pending'
         ORDER BY id ASC
         LIMIT 1`
      )
      .get(scanJobId) as { id: number; path: string; parent_directory_id: number | null } | null;

    if (!row) return null;

    db.prepare(
      `UPDATE scan_walk_queue SET status = 'in_progress', started_at = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), row.id);

    return row;
  })();

  if (!entry) return null;

  let filesIndexed = 0;
  let bytesIndexed = 0;

  try {
    const dirId = await upsertDirectory(db, diskId, scanJobId, entry.path, entry.parent_directory_id);

    const dirEntries = await readDir(entry.path, scanJobId, jobManager);
    if (dirEntries === null) {
      // Permission denied or similar — already logged, mark done and move on
      markQueueEntryDone(db, entry.id);
      return { filesIndexed: 0, bytesIndexed: 0 };
    }

    // Enqueue subdirectories
    const subdirs = dirEntries.filter((e) => e.isDirectory());
    if (subdirs.length > 0) {
      db.transaction(() => {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO scan_walk_queue
             (scan_job_id, disk_id, path, parent_directory_id, status)
           VALUES (?, ?, ?, ?, 'pending')`
        );
        for (const subdir of subdirs) {
          stmt.run(scanJobId, diskId, path.join(entry.path, subdir.name), dirId);
        }
      })();
    }

    // Process files in batches
    const files = dirEntries.filter((e) => e.isFile());
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const { count, bytes } = await upsertFileBatch(
        db,
        diskId,
        dirId,
        entry.path,
        scanJobId,
        batch,
        jobManager
      );
      filesIndexed += count;
      bytesIndexed += bytes;
    }

    markQueueEntryDone(db, entry.id);
    return { filesIndexed, bytesIndexed };
  } catch (err) {
    db.prepare(
      `UPDATE scan_walk_queue SET status = 'error', error_detail = ?, completed_at = ?
       WHERE id = ?`
    ).run(String(err), new Date().toISOString(), entry.id);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readDir(
  dirPath: string,
  scanJobId: number,
  jobManager: JobManager
): Promise<import("fs").Dirent[] | null> {
  try {
    const { readdirSync } = await import("fs");
    return readdirSync(dirPath, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      jobManager.logEvent(
        scanJobId,
        "warning",
        "error",
        `Permission denied: ${dirPath}`,
        { path: dirPath, code: err.code }
      );
      return null;
    }
    throw err;
  }
}

async function upsertDirectory(
  db: Database,
  diskId: number,
  scanJobId: number,
  dirPath: string,
  parentId: number | null
): Promise<number> {
  const name = path.basename(dirPath) || dirPath;
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM directories WHERE disk_id = ? AND path = ?")
    .get(diskId, dirPath) as { id: number } | null;

  if (existing) {
    db.prepare(
      `UPDATE directories SET last_scan_id = ?, parent_id = COALESCE(parent_id, ?) WHERE id = ?`
    ).run(scanJobId, parentId, existing.id);
    return existing.id;
  }

  const row = db
    .prepare(
      `INSERT INTO directories (disk_id, parent_id, name, path, last_scan_id)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(diskId, parentId, name, dirPath, scanJobId) as { id: number };
  return row.id;
}

async function upsertFileBatch(
  db: Database,
  diskId: number,
  directoryId: number,
  dirPath: string,
  scanJobId: number,
  entries: import("fs").Dirent[],
  jobManager: JobManager
): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;

  // Collect file stats + hashes (outside transaction — I/O)
  const fileData: Array<{
    name: string;
    filePath: string;
    sizeBytes: number;
    mtime: string;
    sampledHash: string | null;
    skipped: boolean;
  }> = [];

  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name);
    try {
      const stat = await Bun.file(filePath).stat();

      // iCloud dataless stub — skip to avoid triggering a download
      if ((stat as any).flags !== undefined && ((stat as any).flags & SF_DATALESS) !== 0) {
        jobManager.logEvent(
          scanJobId,
          "warning",
          "excluded",
          `iCloud dataless file skipped: ${filePath}`,
          { path: filePath }
        );
        fileData.push({ name: entry.name, filePath, sizeBytes: 0, mtime: "", sampledHash: null, skipped: true });
        continue;
      }

      const mtime = new Date(stat.mtime).toISOString();
      const sizeBytes = stat.size;

      // mtime+size shortcut: check if we already have this file with matching values
      const existing = db
        .prepare(
          `SELECT id, mtime, size_bytes, sampled_hash
           FROM files
           WHERE disk_id = ? AND directory_id = ? AND name = ?`
        )
        .get(diskId, directoryId, entry.name) as
        | { id: number; mtime: string; size_bytes: number; sampled_hash: string | null }
        | null;

      let sampledHash: string | null = null;
      if (existing && existing.mtime === mtime && existing.size_bytes === sizeBytes && existing.sampled_hash) {
        // Unchanged — reuse stored hash
        sampledHash = existing.sampled_hash;
      } else {
        sampledHash = await computeSampledHash(filePath, sizeBytes);
      }

      fileData.push({ name: entry.name, filePath, sizeBytes, mtime, sampledHash, skipped: false });
      bytes += sizeBytes;
      count++;
    } catch (err: any) {
      jobManager.logEvent(
        scanJobId,
        "warning",
        "error",
        `Could not stat/hash ${filePath}: ${err.message}`,
        { path: filePath, code: err.code }
      );
    }
  }

  // Batch upsert (single transaction)
  db.transaction(() => {
    const now = new Date().toISOString();
    const upsertStmt = db.prepare(
      `INSERT INTO files
         (disk_id, directory_id, name, path, size_bytes, mtime, sampled_hash,
          hash_algo_version, last_scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (disk_id, directory_id, name) DO UPDATE SET
         path              = excluded.path,
         size_bytes        = excluded.size_bytes,
         mtime             = excluded.mtime,
         sampled_hash      = excluded.sampled_hash,
         hash_algo_version = excluded.hash_algo_version,
         last_scan_id      = excluded.last_scan_id`
    );
    for (const f of fileData) {
      if (f.skipped) continue;
      upsertStmt.run(
        diskId,
        directoryId,
        f.name,
        f.filePath,
        f.sizeBytes,
        f.mtime,
        f.sampledHash,
        HASH_ALGO_VERSION,
        scanJobId
      );
    }
  })();

  return { count, bytes };
}

function markQueueEntryDone(db: Database, entryId: number): void {
  db.prepare(
    `UPDATE scan_walk_queue SET status = 'done', completed_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), entryId);
}

/**
 * Recomputes materialized aggregates for all directories on this disk.
 * Called once at the end of each scan job.
 *
 * Uses path-prefix matching: a directory at /foo/bar contributes to all
 * ancestor directories whose path is a prefix of /foo/bar. This is O(dirs²)
 * in the worst case but is a one-time end-of-scan operation over at most a few
 * thousand directories — well within budget.
 */
export function recomputeAggregates(db: Database, diskId: number): void {
  const now = new Date().toISOString();
  db
    .prepare(
      `UPDATE directories
       SET
         direct_file_count = (
           SELECT COUNT(*) FROM files f
           WHERE f.disk_id = directories.disk_id
             AND f.directory_id = directories.id
         ),
         file_count = (
           SELECT COUNT(*) FROM files f
           WHERE f.disk_id = directories.disk_id
             AND f.path LIKE directories.path || '/%'
         ),
         total_size_bytes = (
           SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f
           WHERE f.disk_id = directories.disk_id
             AND f.path LIKE directories.path || '/%'
         ),
         aggregates_computed_at = ?
       WHERE disk_id = ?`
    )
    .run(now, diskId);
}
