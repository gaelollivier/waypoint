import type { Database } from "bun:sqlite";
import { _BLAKE3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { trace } from "../../diag/trace";
import { EXCLUDED_NAMES_SQL } from "../../lib/excluded-names";

const INSERT_BATCH_SIZE = 500;

interface DuplicateGroupRow {
  sampled_hash: string;
  size_bytes: number;
  file_count: number;
}

interface DuplicateFileRow {
  file_id: number;
  path: string;
}

export class DuplicateDetectionJobRunner extends JobRunner {
  private db: Database;
  private diskId: number;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    diskId: number;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.diskId = opts.diskId;
  }

  protected async execute(): Promise<void> {
    trace("duplicate_detection_start", { job_id: this.jobId, disk_id: this.diskId });
    const t0 = performance.now();

    // Resolve the latest completed scan for this disk
    const scanRow = this.db
      .prepare("SELECT last_scan_job_id FROM disks WHERE id = ?")
      .get(this.diskId) as { last_scan_job_id: number | null } | null;
    if (!scanRow?.last_scan_job_id) throw new Error("invariant: disk has no completed scan");
    const scanId = scanRow.last_scan_job_id;

    // ── Phase 1: find all duplicate hashes on this disk ─────────────────────
    await this.checkPause();

    const groups = this.db
      .prepare(
        `SELECT sampled_hash, size_bytes, COUNT(*) AS file_count
         FROM files
         WHERE scan_id = ?
           AND sampled_hash IS NOT NULL
           AND ${EXCLUDED_NAMES_SQL}
         GROUP BY sampled_hash
         HAVING file_count > 1
         ORDER BY size_bytes DESC`
      )
      .all(scanId) as DuplicateGroupRow[];

    const totalWastedBytes = groups.reduce(
      (acc, g) => acc + g.size_bytes * (g.file_count - 1),
      0
    );

    trace("duplicate_detection_groups_found", {
      job_id: this.jobId,
      groups: groups.length,
      wasted_bytes: totalWastedBytes,
    });

    this.logEvent(
      "info",
      "progress_milestone",
      `Found ${groups.length} duplicate group${groups.length === 1 ? "" : "s"} — ${totalWastedBytes} bytes wasted`
    );

    // ── Phase 2: prepare insert statements ──────────────────────────────────
    await this.checkPause();

    const insertGroup = this.db.prepare(
      `INSERT INTO duplicate_groups
         (duplicate_job_id, sampled_hash, file_count, size_bytes, wasted_bytes)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    );

    const selectMembers = this.db.prepare(
      `SELECT id AS file_id, path
       FROM files
       WHERE scan_id = ?
         AND sampled_hash = ?
         AND ${EXCLUDED_NAMES_SQL}`
    );

    const insertFile = this.db.prepare(
      `INSERT INTO duplicate_group_files (group_id, file_id, path)
       VALUES (?, ?, ?)`
    );

    // ── Phase 3: insert groups and their members in batches ──────────────────
    for (let i = 0; i < groups.length; i += INSERT_BATCH_SIZE) {
      const batch = groups.slice(i, i + INSERT_BATCH_SIZE);

      this.db.transaction(() => {
        for (const g of batch) {
          const wastedBytes = g.size_bytes * (g.file_count - 1);
          const { id: groupId } = insertGroup.get(
            this.jobId,
            g.sampled_hash,
            g.file_count,
            g.size_bytes,
            wastedBytes
          ) as { id: number };

          const members = selectMembers.all(
            scanId,
            g.sampled_hash
          ) as DuplicateFileRow[];

          for (const m of members) {
            insertFile.run(groupId, m.file_id, m.path);
          }
        }
      })();

      this.incrementProgress({ itemsProcessed: batch.length });
      await new Promise<void>((r) => setImmediate(r));
      await this.checkPause();
    }

    // ── Phase 4: directory-level duplicate detection ──────────────────────
    await this.checkPause();

    const dirDuplicates = this.computeDirectoryDuplicates(scanId);

    trace("duplicate_detection_end", {
      job_id: this.jobId,
      file_groups: groups.length,
      directory_groups: dirDuplicates,
      ms: Math.round(performance.now() - t0),
    });

    this.logEvent(
      "info",
      "progress_milestone",
      `Duplicate detection complete: ${groups.length} file group${groups.length === 1 ? "" : "s"} (${totalWastedBytes} bytes wasted), ${dirDuplicates} directory group${dirDuplicates === 1 ? "" : "s"}`
    );
  }

  /**
   * Computes a content hash for every directory (bottom-up) and groups
   * directories with identical content. Returns the number of directory
   * duplicate groups created.
   *
   * Algorithm: Process directories deepest-first. For each directory:
   *   entries = sorted list of:
   *     - direct child files:       "filename\0sampled_hash"
   *     - direct child directories: "dirname/\0content_hash"
   *   content_hash = BLAKE3(entries joined by "\n")
   *
   * If any descendant has a null hash, the directory's content_hash is null.
   */
  private computeDirectoryDuplicates(scanId: number): number {
    // Load all directories for this scan
    const dirs = this.db
      .prepare(
        `SELECT id, parent_id, name, path, total_size_bytes
         FROM directories WHERE scan_id = ?`
      )
      .all(scanId) as Array<{
        id: number;
        parent_id: number | null;
        name: string;
        path: string;
        total_size_bytes: number;
      }>;

    if (dirs.length === 0) return 0;

    // Load all files with their directory_id and sampled_hash
    const files = this.db
      .prepare(
        `SELECT directory_id, name, sampled_hash
         FROM files WHERE scan_id = ?`
      )
      .all(scanId) as Array<{
        directory_id: number;
        name: string;
        sampled_hash: string | null;
      }>;

    // Build lookup maps
    const dirById = new Map<number, typeof dirs[number]>();
    const childrenByParent = new Map<number, number[]>();
    const filesByDir = new Map<number, Array<{ name: string; sampledHash: string | null }>>();

    for (const d of dirs) {
      dirById.set(d.id, d);
      if (d.parent_id != null) {
        let children = childrenByParent.get(d.parent_id);
        if (!children) {
          children = [];
          childrenByParent.set(d.parent_id, children);
        }
        children.push(d.id);
      }
    }

    for (const f of files) {
      let dirFiles = filesByDir.get(f.directory_id);
      if (!dirFiles) {
        dirFiles = [];
        filesByDir.set(f.directory_id, dirFiles);
      }
      dirFiles.push({ name: f.name, sampledHash: f.sampled_hash });
    }

    // Compute depth for each directory via memoized parent walk
    const depthCache = new Map<number, number>();
    const getDepth = (id: number): number => {
      const cached = depthCache.get(id);
      if (cached !== undefined) return cached;
      const dir = dirById.get(id);
      if (!dir) throw new Error(`invariant: directory ${id} not found in dirById`);
      const depth = dir.parent_id == null ? 0 : getDepth(dir.parent_id) + 1;
      depthCache.set(id, depth);
      return depth;
    };

    // Sort deepest-first for bottom-up processing
    const sortedDirs = [...dirs].sort((a, b) => getDepth(b.id) - getDepth(a.id));

    // Compute content hashes bottom-up
    const contentHashes = new Map<number, string | null>();
    const encoder = new TextEncoder();

    for (const dir of sortedDirs) {
      const entries: string[] = [];
      let hasNull = false;

      // Direct child files
      const dirFiles = filesByDir.get(dir.id) ?? [];
      for (const f of dirFiles) {
        if (f.sampledHash == null) {
          hasNull = true;
          break;
        }
        entries.push(`${f.name}\0${f.sampledHash}`);
      }

      // Direct child directories
      if (!hasNull) {
        const childDirIds = childrenByParent.get(dir.id) ?? [];
        for (const childId of childDirIds) {
          const childHash = contentHashes.get(childId);
          if (childHash == null) {
            hasNull = true;
            break;
          }
          const childDir = dirById.get(childId);
          if (!childDir) throw new Error(`invariant: child dir ${childId} not found`);
          entries.push(`${childDir.name}/\0${childHash}`);
        }
      }

      if (hasNull) {
        contentHashes.set(dir.id, null);
        continue;
      }

      entries.sort();
      const hasher = new _BLAKE3();
      hasher.update(encoder.encode(entries.join("\n")));
      contentHashes.set(dir.id, bytesToHex(hasher.digest()));
    }

    // Write content hashes to directories table
    const updateHash = this.db.prepare(
      "UPDATE directories SET content_hash = ? WHERE id = ?"
    );
    this.db.transaction(() => {
      for (const [dirId, hash] of contentHashes) {
        updateHash.run(hash, dirId);
      }
    })();

    // Group directories by content_hash (non-null, appearing > 1 time)
    // Only consider directories with at least one file (skip empty dirs)
    const hashGroups = new Map<string, number[]>();
    for (const dir of dirs) {
      const hash = contentHashes.get(dir.id);
      if (hash == null) continue;
      // Skip empty directories (no files at all)
      if (dir.total_size_bytes === 0) continue;

      let group = hashGroups.get(hash);
      if (!group) {
        group = [];
        hashGroups.set(hash, group);
      }
      group.push(dir.id);
    }

    // Filter to groups with > 1 directory and remove subsets:
    // If directory A and its child B both appear as duplicate groups,
    // only keep A (the parent subsumes the child).
    const duplicateEntries: Array<{
      contentHash: string;
      dirIds: number[];
      totalSizeBytes: number;
    }> = [];

    // Collect all dir IDs that are part of any duplicate group
    const dirsInDuplicateGroups = new Set<number>();

    for (const [hash, dirIds] of hashGroups) {
      if (dirIds.length < 2) continue;
      duplicateEntries.push({
        contentHash: hash,
        dirIds,
        totalSizeBytes: dirById.get(dirIds[0])!.total_size_bytes,
      });
      for (const id of dirIds) dirsInDuplicateGroups.add(id);
    }

    // Filter out child directories whose parent is also in a duplicate group.
    // A parent directory being a duplicate subsumes all its children being duplicates.
    const filteredEntries = duplicateEntries.filter((entry) => {
      // Keep this group if at least one member has no ancestor in another duplicate group
      return entry.dirIds.some((dirId) => {
        let current = dirById.get(dirId);
        while (current?.parent_id != null) {
          if (dirsInDuplicateGroups.has(current.parent_id)) return false;
          current = dirById.get(current.parent_id);
        }
        return true;
      });
    });

    // Sort by wasted bytes descending
    filteredEntries.sort((a, b) => {
      const wastedA = a.totalSizeBytes * (a.dirIds.length - 1);
      const wastedB = b.totalSizeBytes * (b.dirIds.length - 1);
      return wastedB - wastedA;
    });

    this.logEvent(
      "info",
      "progress_milestone",
      `Found ${filteredEntries.length} directory duplicate group${filteredEntries.length === 1 ? "" : "s"}`
    );

    // Insert directory duplicate groups
    if (filteredEntries.length > 0) {
      const insertDirGroup = this.db.prepare(
        `INSERT INTO duplicate_directory_groups
           (duplicate_job_id, content_hash, directory_count, total_size_bytes, wasted_bytes)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id`
      );
      const insertDirMember = this.db.prepare(
        `INSERT INTO duplicate_directory_group_members (group_id, directory_id, path)
         VALUES (?, ?, ?)`
      );

      for (let i = 0; i < filteredEntries.length; i += INSERT_BATCH_SIZE) {
        const batch = filteredEntries.slice(i, i + INSERT_BATCH_SIZE);
        this.db.transaction(() => {
          for (const entry of batch) {
            const wastedBytes = entry.totalSizeBytes * (entry.dirIds.length - 1);
            const { id: groupId } = insertDirGroup.get(
              this.jobId,
              entry.contentHash,
              entry.dirIds.length,
              entry.totalSizeBytes,
              wastedBytes
            ) as { id: number };

            for (const dirId of entry.dirIds) {
              const dir = dirById.get(dirId);
              if (!dir) throw new Error(`invariant: dir ${dirId} not found for insert`);
              insertDirMember.run(groupId, dirId, dir.path);
            }
          }
        })();
      }
    }

    return filteredEntries.length;
  }
}
