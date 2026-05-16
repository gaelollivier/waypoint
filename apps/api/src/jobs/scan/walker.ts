import type { Database } from "bun:sqlite";
import path from "path";
import { readDirectory, statFile } from "../../fs/disk-reads";
import { computeFullHashStreaming, computeSampledHash, HASH_ALGO_VERSION } from "./hasher";
import type { JobManager } from "../job-manager";
import { trace } from "../../diag/trace";
import { isExcludedName } from "../../lib/excluded-names";

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
  previousScanId: number | null,
  jobManager: JobManager,
  fullHash: boolean = false
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
    const dirId = insertDirectory(db, diskId, scanJobId, entry.path, entry.parent_directory_id);
    timings.insert_dir_ms = Math.round(performance.now() - tA);

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

    // Process files in this directory (concurrent stat+hash, single batched DB write).
    // Filter out macOS metadata noise at scan time so it never enters the DB.
    const files = dirEntries.filter((e) => e.isFile() && !isExcludedName(e.name));
    if (files.length > 0) {
      const tD = performance.now();
      const { count, bytes, hashPoolMs, insertMs, selectMs } = await insertFileBatch(
        db,
        diskId,
        dirId,
        entry.path,
        scanJobId,
        previousScanId,
        files,
        jobManager,
        fullHash
      );
      timings.files_total_ms = Math.round(performance.now() - tD);
      timings.files_select_ms = selectMs;
      timings.files_hash_pool_ms = hashPoolMs;
      timings.files_insert_ms = insertMs;
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

function insertDirectory(
  db: Database,
  diskId: number,
  scanJobId: number,
  dirPath: string,
  parentId: number | null
): number {
  const name = path.basename(dirPath) || dirPath;

  const row = db
    .prepare(
      `INSERT INTO directories (disk_id, scan_id, parent_id, name, path)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(diskId, scanJobId, parentId, name, dirPath) as { id: number };
  return row.id;
}

async function insertFileBatch(
  db: Database,
  diskId: number,
  directoryId: number,
  dirPath: string,
  scanJobId: number,
  previousScanId: number | null,
  entries: import("fs").Dirent[],
  jobManager: JobManager,
  fullHashMode: boolean
): Promise<{ count: number; bytes: number; selectMs: number; hashPoolMs: number; insertMs: number }> {
  // Look up previous scan's rows for this directory (by path) to reuse hashes
  // when mtime+size are unchanged. Plain scans may carry full_hash forward so
  // they don't lose data accumulated by an earlier fullHash scan. Full-hash
  // scans deliberately do not reuse full_hash: their purpose is to re-read
  // every byte from disk and catch latent corruption.
  const tSelect = performance.now();
  let existingMap = new Map<
    string,
    { mtime: string; size_bytes: number; sampled_hash: string | null; full_hash: string | null }
  >();

  if (previousScanId !== null) {
    // Find the same directory in the previous scan by path
    const prevDir = db
      .prepare("SELECT id FROM directories WHERE scan_id = ? AND path = ?")
      .get(previousScanId, dirPath) as { id: number } | null;

    if (prevDir) {
      const placeholders = entries.map(() => "?").join(",");
      const names = entries.map((e) => e.name);
      const existingRows = db
        .prepare(
          `SELECT name, mtime, size_bytes, sampled_hash, full_hash
           FROM files
           WHERE scan_id = ? AND directory_id = ? AND name IN (${placeholders})`
        )
        .all(previousScanId, prevDir.id, ...names) as Array<{
        name: string;
        mtime: string;
        size_bytes: number;
        sampled_hash: string | null;
        full_hash: string | null;
      }>;
      existingMap = new Map(existingRows.map((r) => [r.name, r]));
    }
  }
  const selectMs = Math.round(performance.now() - tSelect);

  type FileRecord = {
    name: string;
    filePath: string;
    sizeBytes: number;
    mtime: string;
    sampledHash: string | null;
    fullHash: string | null;
  };
  const fileData: FileRecord[] = [];

  async function processOne(entry: import("fs").Dirent): Promise<void> {
    const filePath = path.join(dirPath, entry.name);
    try {
      const stat = await statFile(filePath);
      const mtime = stat.mtime.toISOString();
      const sizeBytes = stat.size;
      const existing = existingMap.get(entry.name);
      const unchanged =
        existing != null &&
        existing.mtime === mtime &&
        existing.size_bytes === sizeBytes;

      let sampledHash: string | null = null;
      let fullHash: string | null = null;

      if (unchanged && existing.sampled_hash) {
        // mtime+size unchanged — reuse stored sampled hash, skip I/O
        sampledHash = existing.sampled_hash;
      } else {
        sampledHash = await computeSampledHash(filePath, sizeBytes);
      }

      // Full-hash scans are integrity scans: always re-read every byte so bit
      // flips outside sampled regions are detected. Plain scans may carry an
      // existing full_hash forward when a fresh or reused sampled hash still
      // matches the prior row, preserving accumulated hash coverage cheaply.
      if (fullHashMode) {
        fullHash = await computeFullHashStreaming(filePath);
      } else if (existing?.full_hash && existing.sampled_hash === sampledHash) {
        fullHash = existing.full_hash;
      }

      fileData.push({ name: entry.name, filePath, sizeBytes, mtime, sampledHash, fullHash });
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

  // Single transaction for all inserts in this directory
  const tInsert = performance.now();
  db.transaction(() => {
    const insertStmt = db.prepare(
      `INSERT INTO files
         (disk_id, scan_id, directory_id, name, path, size_bytes, mtime,
          sampled_hash, full_hash, hash_algo_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of fileData) {
      insertStmt.run(
        diskId,
        scanJobId,
        directoryId,
        f.name,
        f.filePath,
        f.sizeBytes,
        f.mtime,
        f.sampledHash,
        f.fullHash,
        HASH_ALGO_VERSION,
      );
      count++;
      bytes += f.sizeBytes;
    }
  })();
  const insertMs = Math.round(performance.now() - tInsert);

  return { count, bytes, selectMs, hashPoolMs, insertMs };
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

export async function recomputeAggregates(db: Database, scanId: number): Promise<void> {
  const t0 = performance.now();

  // 1. Direct (count, bytes) per directory — single grouped scan.
  const tGroup = performance.now();
  const directRows = db
    .prepare(
      `SELECT directory_id AS id, COUNT(*) AS direct_n, COALESCE(SUM(size_bytes), 0) AS direct_b
         FROM files
        WHERE scan_id = ?
        GROUP BY directory_id`
    )
    .all(scanId) as Array<{ id: number; direct_n: number; direct_b: number }>;
  const groupMs = Math.round(performance.now() - tGroup);

  // 2. Load directory tree (id + parent_id) for this scan.
  const tDirs = performance.now();
  const dirRows = db
    .prepare("SELECT id, parent_id FROM directories WHERE scan_id = ?")
    .all(scanId) as Array<{ id: number; parent_id: number | null }>;
  const dirsLoadMs = Math.round(performance.now() - tDirs);

  // Build per-dir state, seeded with direct totals.
  type Acc = { directN: number; directB: number; totalN: number; totalB: number; parentId: number | null; depth: number };
  const acc = new Map<number, Acc>();
  for (const d of dirRows) {
    acc.set(d.id, { directN: 0, directB: 0, totalN: 0, totalB: 0, parentId: d.parent_id, depth: 0 });
  }
  for (const r of directRows) {
    const a = acc.get(r.id);
    // Invariant: every directory_id in `files` must have a row in `directories`
    // (enforced by FK). If this fires, the DB is corrupt.
    if (!a) throw new Error(`aggregates invariant violated: directory id ${r.id} in files but not in directories`);
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
    // depth 0 = root dir, which simply re-walks (cheap, one iteration).
    // Using 0 as "not yet computed" is intentional — a separate sentinel is not worth the complexity.
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
    scan_id: scanId,
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
