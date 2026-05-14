import type { Database } from "bun:sqlite";
import path from "path";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { trace } from "../../diag/trace";
import { EXCLUDED_NAMES_SQL } from "../../lib/excluded-names";

// How many diff_entries rows to insert per transaction batch.
const INSERT_BATCH_SIZE = 1000;
// Yield to the event loop every N rows during the diff_dirs writeback.
const YIELD_EVERY = 500;

export type DiffKind = "added" | "removed" | "changed" | "present";

interface DiffEntryInsert {
  sourceFileId: number | null;
  destFileId: number | null;
  kind: DiffKind;
  /** Relative path within the source disk (leading '/').
   *  For 'removed' entries: relative to the dest disk mount. */
  path: string;
  sizeBytes: number;
}

/** Strip a mount path prefix to get a disk-relative path, e.g.
 *  relPath("/Volumes/HDD", "/Volumes/HDD/Documents/file.txt") → "/Documents/file.txt"
 *  relPath("/Volumes/HDD", "/Volumes/HDD") → "/"   (root itself) */
function relPath(mountPath: string, absPath: string): string {
  if (absPath === mountPath) return "/";
  const rel = absPath.slice(mountPath.length);
  return rel.startsWith("/") ? rel : "/" + rel;
}

export class DiffJobRunner extends JobRunner {
  private db: Database;
  private sourceDiskId: number;
  private destDiskId: number;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    sourceDiskId: number;
    destDiskId: number;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.sourceDiskId = opts.sourceDiskId;
    this.destDiskId = opts.destDiskId;
  }

  protected async execute(): Promise<void> {
    trace("diff_start", {
      job_id: this.jobId,
      source_disk_id: this.sourceDiskId,
      dest_disk_id: this.destDiskId,
    });

    // ----------------------------------------------------------------
    // 0. Resolve mount paths (needed to relativize file paths)
    // ----------------------------------------------------------------
    const sourceDisk = this.db
      .prepare("SELECT mount_path FROM disks WHERE id = ?")
      .get(this.sourceDiskId) as { mount_path: string | null } | null;
    const destDisk = this.db
      .prepare("SELECT mount_path FROM disks WHERE id = ?")
      .get(this.destDiskId) as { mount_path: string | null } | null;

    const sourceMountPath = sourceDisk?.mount_path ?? "";
    const destMountPath = destDisk?.mount_path ?? "";

    // ----------------------------------------------------------------
    // 1. Load source files; build relative-path lookup map
    // ----------------------------------------------------------------
    const t0 = performance.now();
    await this.checkPause();

    const sourceFiles = this.db
      .prepare(
        `SELECT id, path, sampled_hash, size_bytes
         FROM files
         WHERE disk_id = ? AND ${EXCLUDED_NAMES_SQL}`
      )
      .all(this.sourceDiskId) as Array<{
        id: number;
        path: string;
        sampled_hash: string | null;
        size_bytes: number;
      }>;

    // ----------------------------------------------------------------
    // 2. Load dest files; build a lookup map keyed by relative path
    // ----------------------------------------------------------------
    const destFiles = this.db
      .prepare(
        `SELECT id, path, sampled_hash, size_bytes
         FROM files
         WHERE disk_id = ? AND ${EXCLUDED_NAMES_SQL}`
      )
      .all(this.destDiskId) as Array<{
        id: number;
        path: string;
        sampled_hash: string | null;
        size_bytes: number;
      }>;

    // Map: relative path → dest file row
    const destByRelPath = new Map(
      destFiles.map((f) => [relPath(destMountPath, f.path), f])
    );
    // Set of all dest relative paths (for removed detection)
    const destRelPathSet = new Set(destByRelPath.keys());

    trace("diff_loaded", {
      job_id: this.jobId,
      source_files: sourceFiles.length,
      dest_files: destFiles.length,
      load_ms: Math.round(performance.now() - t0),
    });

    // ----------------------------------------------------------------
    // 3. Classify source files (added / changed / present)
    // ----------------------------------------------------------------
    await this.checkPause();

    const entries: DiffEntryInsert[] = [];
    const sourceRelPaths = new Set<string>();

    for (const sf of sourceFiles) {
      const rel = relPath(sourceMountPath, sf.path);
      sourceRelPaths.add(rel);
      const df = destByRelPath.get(rel);

      if (!df) {
        entries.push({ sourceFileId: sf.id, destFileId: null, kind: "added", path: rel, sizeBytes: sf.size_bytes });
      } else if (!sf.sampled_hash || !df.sampled_hash || sf.sampled_hash !== df.sampled_hash) {
        // Treat a NULL hash on either side as changed — unknown hash means "needs copy".
        // This is conservative: we never silently skip a file just because we couldn't hash it.
        entries.push({ sourceFileId: sf.id, destFileId: df.id, kind: "changed", path: rel, sizeBytes: sf.size_bytes });
      } else {
        entries.push({ sourceFileId: sf.id, destFileId: df.id, kind: "present", path: rel, sizeBytes: sf.size_bytes });
      }
    }

    // ----------------------------------------------------------------
    // 4. Classify dest-only files (removed)
    // ----------------------------------------------------------------
    for (const df of destFiles) {
      const rel = relPath(destMountPath, df.path);
      if (!sourceRelPaths.has(rel)) {
        entries.push({ sourceFileId: null, destFileId: df.id, kind: "removed", path: rel, sizeBytes: df.size_bytes });
      }
    }

    const added   = entries.filter((e) => e.kind === "added").length;
    const changed = entries.filter((e) => e.kind === "changed").length;
    const removed = entries.filter((e) => e.kind === "removed").length;
    const present = entries.filter((e) => e.kind === "present").length;

    trace("diff_classified", { job_id: this.jobId, added, changed, removed, present, total: entries.length });

    this.logEvent(
      "info",
      "progress_milestone",
      `Diff: ${added} added, ${changed} changed, ${removed} removed, ${present} present`
    );

    // ----------------------------------------------------------------
    // 5. Build the diff_dirs skeleton from all unique parent paths
    // ----------------------------------------------------------------
    await this.checkPause();

    const dirPathSet = new Set<string>(["/"]);
    for (const e of entries) {
      let p = path.dirname(e.path);
      while (p && p !== ".") {
        if (p === "/") { dirPathSet.add("/"); break; }
        dirPathSet.add(p);
        const next = path.dirname(p);
        if (next === p) break;
        p = next;
      }
    }

    // Insert diff_dirs shallowest-first so parent_id is known when child inserts
    const sortedDirPaths = [...dirPathSet].sort((a, b) => {
      const da = a === "/" ? 0 : a.split("/").length - 1;
      const db2 = b === "/" ? 0 : b.split("/").length - 1;
      return da - db2;
    });

    const dirIdByPath = new Map<string, number>();
    const insertDirStmt = this.db.prepare(
      `INSERT INTO diff_dirs (diff_job_id, parent_id, path) VALUES (?, ?, ?) RETURNING id`
    );

    this.db.transaction(() => {
      for (const dp of sortedDirPaths) {
        const parentPath = dp === "/" ? null : path.dirname(dp);
        let parentId: number | null = null;
        if (parentPath !== null) {
          const found = dirIdByPath.get(parentPath);
          // Invariant: dirs are inserted shallowest-first, so the parent must
          // already be in the map by the time we process a child.
          if (found === undefined) throw new Error(`diff_dirs invariant violated: parent path "${parentPath}" not in dirIdByPath`);
          parentId = found;
        }
        const row = insertDirStmt.get(this.jobId, parentId, dp) as { id: number };
        dirIdByPath.set(dp, row.id);
      }
    })();

    // ----------------------------------------------------------------
    // 6. Insert diff_entries in batches
    // ----------------------------------------------------------------
    await this.checkPause();

    const insertEntryStmt = this.db.prepare(
      `INSERT INTO diff_entries
         (diff_job_id, diff_dir_id, source_file_id, dest_file_id, kind, path, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;
    for (let i = 0; i < entries.length; i += INSERT_BATCH_SIZE) {
      const batch = entries.slice(i, i + INSERT_BATCH_SIZE);
      this.db.transaction(() => {
        for (const e of batch) {
          let dirPath = path.dirname(e.path);
          if (dirPath === "." || dirPath === "") dirPath = "/";
          // Invariant: every parent path was added to dirPathSet in step 5, so
          // dirIdByPath must contain an entry for every entry's parent dir.
          const diffDirId = dirIdByPath.get(dirPath);
          if (diffDirId === undefined) throw new Error(`diff_entries invariant violated: dirPath "${dirPath}" not in dirIdByPath`);
          insertEntryStmt.run(
            this.jobId, diffDirId, e.sourceFileId, e.destFileId, e.kind, e.path, e.sizeBytes
          );
        }
      })();
      inserted += batch.length;
      this.incrementProgress({ itemsProcessed: batch.length });
      await new Promise<void>((r) => setImmediate(r));
    }

    trace("diff_entries_inserted", { job_id: this.jobId, count: inserted });

    // ----------------------------------------------------------------
    // 7. Roll up diff_dirs aggregates (bottom-up, O(entries + dirs))
    // ----------------------------------------------------------------
    await this.checkPause();
    await this._rollupDiffDirs();

    trace("diff_end", { job_id: this.jobId, ms: Math.round(performance.now() - t0) });
  }

  /**
   * Populates diff_dirs aggregate columns via the same O(entries+dirs)
   * bottom-up rollup used by recomputeAggregates in the scan job.
   */
  private async _rollupDiffDirs(): Promise<void> {
    const t0 = performance.now();

    // 1. Direct per-dir totals from diff_entries
    const directRows = this.db
      .prepare(
        `SELECT diff_dir_id AS dir_id, kind,
                COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b
         FROM diff_entries
         WHERE diff_job_id = ? AND diff_dir_id IS NOT NULL
         GROUP BY diff_dir_id, kind`
      )
      .all(this.jobId) as Array<{ dir_id: number; kind: DiffKind; n: number; b: number }>;

    // 2. Load directory tree
    const dirRows = this.db
      .prepare("SELECT id, parent_id FROM diff_dirs WHERE diff_job_id = ?")
      .all(this.jobId) as Array<{ id: number; parent_id: number | null }>;

    type Acc = {
      parentId: number | null;
      depth: number;
      added_count: number;   added_bytes: number;
      changed_count: number; changed_bytes: number;
      removed_count: number; removed_bytes: number;
      present_count: number; present_bytes: number;
    };

    const acc = new Map<number, Acc>();
    for (const d of dirRows) {
      acc.set(d.id, {
        parentId: d.parent_id,
        depth: 0,
        added_count: 0,   added_bytes: 0,
        changed_count: 0, changed_bytes: 0,
        removed_count: 0, removed_bytes: 0,
        present_count: 0, present_bytes: 0,
      });
    }

    for (const r of directRows) {
      const a = acc.get(r.dir_id);
      if (!a) continue;
      if (r.kind === "added")   { a.added_count   += r.n; a.added_bytes   += r.b; }
      if (r.kind === "changed") { a.changed_count += r.n; a.changed_bytes += r.b; }
      if (r.kind === "removed") { a.removed_count += r.n; a.removed_bytes += r.b; }
      if (r.kind === "present") { a.present_count += r.n; a.present_bytes += r.b; }
    }

    function depth(id: number): number {
      const a = acc.get(id);
      if (!a) return 0;
      if (a.depth !== 0) return a.depth;
      let d = 0;
      let cur: number | null = id;
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

    for (const [, node] of sorted) {
      if (node.parentId == null) continue;
      const parent = acc.get(node.parentId);
      if (!parent) continue;
      parent.added_count   += node.added_count;   parent.added_bytes   += node.added_bytes;
      parent.changed_count += node.changed_count; parent.changed_bytes += node.changed_bytes;
      parent.removed_count += node.removed_count; parent.removed_bytes += node.removed_bytes;
      parent.present_count += node.present_count; parent.present_bytes += node.present_bytes;
    }

    const stmt = this.db.prepare(
      `UPDATE diff_dirs
       SET added_count    = ?, added_bytes    = ?,
           changed_count  = ?, changed_bytes  = ?,
           removed_count  = ?, removed_bytes  = ?,
           present_count  = ?, present_bytes  = ?
       WHERE id = ?`
    );

    this.db.exec("BEGIN");
    try {
      let i = 0;
      for (const [id, a] of acc) {
        stmt.run(
          a.added_count, a.added_bytes,
          a.changed_count, a.changed_bytes,
          a.removed_count, a.removed_bytes,
          a.present_count, a.present_bytes,
          id
        );
        i++;
        if (i % YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    trace("diff_rollup_done", { job_id: this.jobId, dirs: acc.size, ms: Math.round(performance.now() - t0) });
  }
}
