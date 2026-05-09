import type { Database } from "bun:sqlite";
import path from "path";
import { readDirectory, statFile } from "../../fs/disk-io";
import { computeSampledHash, HASH_ALGO_VERSION } from "./hasher";
import type { JobManager } from "../job-manager";
import { trace } from "../../diag/trace";

// SF_DATALESS flag — macOS iCloud stub files that haven't been downloaded.
// Reading them would trigger a network fetch. Detect and skip.
const SF_DATALESS = 0x40000000;

// How many files to stat+hash in parallel within a single directory.
//
// Hashing is BLAKE3 in pure JS (sync CPU). With concurrency too high, all
// workers return from their tiny I/O slice in the same tick and queue a long
// run of synchronous hash+update + DB writes back-to-back, starving the HTTP
// event loop.
//
// HDDs will likely want even less (1) to avoid head thrash.
// TODO: tune by `disk.kind` once we benchmark an HDD.
// TODO: move BLAKE3 hashing into a Worker thread so the main loop only handles
// DB+HTTP. See docs/open-questions.md → "Worker-based hashing".
const SCAN_CONCURRENCY = 4;

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
  const t0 = performance.now();
  const timings: Record<string, number> = {};

  try {
    const tA = performance.now();
    const dirId = await upsertDirectory(db, diskId, scanJobId, entry.path, entry.parent_directory_id);
    timings.upsert_dir_ms = Math.round(performance.now() - tA);

    const tB = performance.now();
    const dirEntries = await readDirEntries(entry.path, scanJobId, jobManager);
    timings.readdir_ms = Math.round(performance.now() - tB);
    if (dirEntries === null) {
      // Permission denied or similar — already logged, mark done and move on
      markQueueEntryDone(db, entry.id);
      return { filesIndexed: 0, bytesIndexed: 0 };
    }

    // Enqueue subdirectories
    const subdirs = dirEntries.filter((e) => e.isDirectory());
    if (subdirs.length > 0) {
      const tC = performance.now();
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
      timings.enqueue_subdirs_ms = Math.round(performance.now() - tC);
    }

    // Process files in this directory (concurrent stat+hash, single batched DB write)
    const files = dirEntries.filter((e) => e.isFile());
    if (files.length > 0) {
      const tD = performance.now();
      const { count, bytes, hashPoolMs, upsertMs, selectMs } = await upsertFileBatch(
        db,
        diskId,
        dirId,
        entry.path,
        scanJobId,
        files,
        jobManager
      );
      timings.files_total_ms = Math.round(performance.now() - tD);
      timings.files_select_ms = selectMs;
      timings.files_hash_pool_ms = hashPoolMs;
      timings.files_upsert_ms = upsertMs;
      filesIndexed += count;
      bytesIndexed += bytes;
    }

    markQueueEntryDone(db, entry.id);

    const totalMs = Math.round(performance.now() - t0);
    // Log every directory that took >100ms or had >500 files. Cheap directories
    // are silenced so the trace stays readable.
    if (totalMs > 100 || dirEntries.length > 500) {
      trace("dir_done", {
        path: entry.path,
        files: files.length,
        subdirs: subdirs.length,
        total_ms: totalMs,
        ...timings,
      });
    }

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

async function readDirEntries(
  dirPath: string,
  scanJobId: number,
  jobManager: JobManager
): Promise<import("fs").Dirent[] | null> {
  try {
    return await readDirectory(dirPath);
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
): Promise<{ count: number; bytes: number; selectMs: number; hashPoolMs: number; upsertMs: number }> {
  // Single batched lookup of existing rows, instead of one SELECT per file.
  const tSelect = performance.now();
  const placeholders = entries.map(() => "?").join(",");
  const names = entries.map((e) => e.name);
  const existingRows = db
    .prepare(
      `SELECT name, mtime, size_bytes, sampled_hash
       FROM files
       WHERE disk_id = ? AND directory_id = ? AND name IN (${placeholders})`
    )
    .all(diskId, directoryId, ...names) as Array<{
    name: string;
    mtime: string;
    size_bytes: number;
    sampled_hash: string | null;
  }>;
  const existingMap = new Map(existingRows.map((r) => [r.name, r]));
  const selectMs = Math.round(performance.now() - tSelect);

  type FileRecord = {
    name: string;
    filePath: string;
    sizeBytes: number;
    mtime: string;
    sampledHash: string | null;
    skipped: boolean;
  };
  const fileData: FileRecord[] = [];

  async function processOne(entry: import("fs").Dirent): Promise<void> {
    const filePath = path.join(dirPath, entry.name);
    try {
      const stat = await statFile(filePath);

      // iCloud dataless stub — skip to avoid triggering a download
      if (stat.flags !== undefined && (stat.flags & SF_DATALESS) !== 0) {
        jobManager.logEvent(
          scanJobId,
          "warning",
          "excluded",
          `iCloud dataless file skipped: ${filePath}`,
          { path: filePath }
        );
        fileData.push({ name: entry.name, filePath, sizeBytes: 0, mtime: "", sampledHash: null, skipped: true });
        return;
      }

      const mtime = stat.mtime.toISOString();
      const sizeBytes = stat.size;
      const existing = existingMap.get(entry.name);

      let sampledHash: string | null = null;
      if (existing && existing.mtime === mtime && existing.size_bytes === sizeBytes && existing.sampled_hash) {
        // mtime+size unchanged — reuse stored hash, skip I/O
        sampledHash = existing.sampled_hash;
      } else {
        sampledHash = await computeSampledHash(filePath, sizeBytes);
      }

      fileData.push({ name: entry.name, filePath, sizeBytes, mtime, sampledHash, skipped: false });
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

  // Worker pool: SCAN_CONCURRENCY workers drain a shared queue.
  // JS is single-threaded, so queue.shift() between awaits is race-free.
  //
  // After each file, we yield to the macrotask queue via setImmediate.
  // Without this, large directories (10k+ files) keep the worker pool busy on
  // microtasks for seconds — the HTTP server never gets a turn and the whole
  // API appears frozen. setImmediate explicitly hands control to I/O/timer
  // callbacks, including pending HTTP requests.
  const tHash = performance.now();
  const queue = [...entries];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      await processOne(queue.shift()!);
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, entries.length) }, worker)
  );
  const hashPoolMs = Math.round(performance.now() - tHash);

  let count = 0;
  let bytes = 0;

  // Single transaction for all upserts in this directory
  const tUpsert = performance.now();
  db.transaction(() => {
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
      count++;
      bytes += f.sizeBytes;
    }
  })();
  const upsertMs = Math.round(performance.now() - tUpsert);

  return { count, bytes, selectMs, hashPoolMs, upsertMs };
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
 * Algorithm: O(files + dirs), all I/O delegated to SQLite, roll-up done in JS.
 *
 *   1. Single GROUP BY on `files` → direct (count, bytes) per directory.
 *      Uses the (disk_id, directory_id) index. Returns one row per directory,
 *      not per file — memory cost is O(dirs) regardless of file count.
 *   2. Load (id, parent_id) for every directory on the disk — O(dirs).
 *   3. Sort directories by depth descending, accumulate each dir's running
 *      totals into its parent. By the time a parent is processed, all
 *      descendants have already contributed. O(dirs × max_depth).
 *   4. Single transaction writes back the three aggregate columns. Yields to
 *      the event loop every YIELD_EVERY rows so HTTP/SSE can run during the
 *      writeback (~thousands of small UPDATEs).
 *
 * This replaces a previous correlated-subquery UPDATE that ran ~670M LIKE
 * comparisons synchronously and froze the API for ~3 minutes on the source
 * dataset (177K files / 3.7K dirs). See docs/open-questions.md → freeze.
 */
const YIELD_EVERY = 500;

export async function recomputeAggregates(db: Database, diskId: number): Promise<void> {
  const t0 = performance.now();

  // 1. Direct (count, bytes) per directory — single grouped scan.
  const tGroup = performance.now();
  const directRows = db
    .prepare(
      `SELECT directory_id AS id, COUNT(*) AS direct_n, COALESCE(SUM(size_bytes), 0) AS direct_b
         FROM files
        WHERE disk_id = ?
        GROUP BY directory_id`
    )
    .all(diskId) as Array<{ id: number; direct_n: number; direct_b: number }>;
  const groupMs = Math.round(performance.now() - tGroup);

  // 2. Load directory tree (id + parent_id) for this disk.
  const tDirs = performance.now();
  const dirRows = db
    .prepare("SELECT id, parent_id FROM directories WHERE disk_id = ?")
    .all(diskId) as Array<{ id: number; parent_id: number | null }>;
  const dirsLoadMs = Math.round(performance.now() - tDirs);

  // Build per-dir state, seeded with direct totals.
  type Acc = { directN: number; directB: number; totalN: number; totalB: number; parentId: number | null; depth: number };
  const acc = new Map<number, Acc>();
  for (const d of dirRows) {
    acc.set(d.id, { directN: 0, directB: 0, totalN: 0, totalB: 0, parentId: d.parent_id, depth: 0 });
  }
  for (const r of directRows) {
    const a = acc.get(r.id);
    if (!a) continue; // file pointing to a missing directory — defensive
    a.directN = r.direct_n;
    a.directB = r.direct_b;
    a.totalN = r.direct_n;
    a.totalB = r.direct_b;
  }

  // 3. Compute depth via memoized parent walk, then sort deepest-first.
  const tDepth = performance.now();
  function depth(id: number): number {
    const a = acc.get(id);
    if (!a) return 0;
    if (a.depth !== 0) return a.depth;
    let d = 0;
    let cur: number | null = id;
    // Walk up; cap at the directory count to defend against accidental cycles.
    let safety = acc.size + 1;
    while (cur !== null && safety-- > 0) {
      const node = acc.get(cur);
      if (!node || node.parentId === null) break;
      cur = node.parentId;
      d++;
    }
    a.depth = d;
    return d;
  }
  const sorted = [...acc.entries()].sort((a, b) => depth(b[0]) - depth(a[0]));
  const depthMs = Math.round(performance.now() - tDepth);

  // 4. Roll up: each dir contributes its totals to its parent. Deepest first
  //    means parents see fully-aggregated children.
  const tRollup = performance.now();
  for (const [, node] of sorted) {
    if (node.parentId == null) continue;
    const parent = acc.get(node.parentId);
    if (!parent) continue;
    parent.totalN += node.totalN;
    parent.totalB += node.totalB;
  }
  const rollupMs = Math.round(performance.now() - tRollup);

  // 5. Write back. One transaction, yielding every YIELD_EVERY rows so the
  //    event loop can serve HTTP requests during the writeback.
  const tWrite = performance.now();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE directories
        SET direct_file_count = ?,
            file_count        = ?,
            total_size_bytes  = ?,
            aggregates_computed_at = ?
      WHERE id = ?`
  );

  // We can't yield inside a sync db.transaction(), so we open the txn manually
  // and chunk in batches separated by setImmediate yields.
  db.exec("BEGIN");
  try {
    let i = 0;
    for (const [id, a] of acc) {
      stmt.run(a.directN, a.totalN, a.totalB, now, id);
      i++;
      if (i % YIELD_EVERY === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const writeMs = Math.round(performance.now() - tWrite);

  trace("aggregates_done", {
    disk_id: diskId,
    dirs: acc.size,
    direct_groups: directRows.length,
    total_ms: Math.round(performance.now() - t0),
    group_ms: groupMs,
    dirs_load_ms: dirsLoadMs,
    depth_ms: depthMs,
    rollup_ms: rollupMs,
    write_ms: writeMs,
  });
}
