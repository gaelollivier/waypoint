import type { Database } from "bun:sqlite";
import path from "path";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { readDirectory } from "../../fs/disk-reads";
import {
  deleteDuplicateFile,
  deleteExcludedNoiseFile,
  removeEmptyDirectoryInsideMount,
} from "../../fs/disk-writes";
import {
  computeFileFreshness,
  freshnessMismatchReason,
  type FileFreshness,
} from "../../lib/freshness";
import { isExcludedName } from "../../lib/excluded-names";
import { LockManager } from "../../locks/lock-manager";
import { getLockManager } from "../../locks";
import { trace } from "../../diag/trace";

/**
 * Job payload for directory_duplicate_cleanup.
 *
 * Carries the same explicit per-file echo the file-level cleanup uses, so the
 * human's reviewed view of "what is about to be deleted" travels with the job
 * and we can re-validate against the DB at execution time.
 */
export interface DirectoryDuplicateCleanupPayload {
  duplicateDirectoryGroupId: number;
  keepDirectory: { directoryId: number; path: string };
  deleteDirectories: Array<{
    directoryId: number;
    path: string;
    /** Scan-recorded files; deleted via the hash-proof `deleteDuplicateFile`. */
    files: Array<{ fileId: number; relativePath: string }>;
    /**
     * OS/Waypoint noise files the scan intentionally never indexed (the UI
     * echoed them back from the live inventory). Deleted via the name-
     * allowlist `deleteExcludedNoiseFile` gateway. Optional so payloads
     * created before this field existed remain valid.
     */
    excludedFiles?: Array<{ relativePath: string }>;
  }>;
}

/**
 * Cleanup job for directory duplicate groups. Iterates the explicit list of
 * delete-directories, pair-verifies every file against its keep-folder
 * counterpart by relative path, and deletes via the existing per-file
 * gateway. After every file in a delete folder has been unlinked, empties
 * are removed bottom-up.
 *
 * The job FAILS-FAST. Any unexpected drift — extra on-disk files, missing
 * pair, hash mismatch, gateway refusal — aborts the job with the failing
 * step recorded in the event log.
 */
export class DirectoryDuplicateCleanupJobRunner extends JobRunner {
  private db: Database;
  private diskId: number;
  private diskMountPath: string;
  private scanId: number;
  private payload: DirectoryDuplicateCleanupPayload;
  private lockManager: LockManager;
  private releaseLock: (() => void) | null = null;

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    diskId: number;
    diskMountPath: string;
    scanId: number;
    payload: DirectoryDuplicateCleanupPayload;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.diskId = opts.diskId;
    this.diskMountPath = opts.diskMountPath;
    this.scanId = opts.scanId;
    this.payload = opts.payload;
    this.lockManager = getLockManager();
  }

  // Coordinate the disk write lock with the runner lifecycle so the UI's
  // pause/resume/cancel surface mirrors what other write jobs (e.g. copy)
  // already do.
  override pause(): void {
    this.lockManager.pause(this.diskId, this.jobId);
    super.pause();
  }

  override resume(): void {
    super.resume();
    this.lockManager.resume(this.diskId, this.jobId);
  }

  override cancel(): void {
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
    super.cancel();
  }

  protected async execute(): Promise<void> {
    const t0 = performance.now();
    trace("directory_cleanup_start", {
      job_id: this.jobId,
      group_id: this.payload.duplicateDirectoryGroupId,
      delete_dirs: this.payload.deleteDirectories.length,
    });

    // The route already verified the lock was free at job-creation time via
    // tryAcquire; here we make the hold for real and keep it for the lifetime
    // of the cleanup so no other writer can race us.
    this.releaseLock = await this.lockManager.acquire(this.diskId, this.jobId);

    try {
      const { keepDirectory, deleteDirectories } = this.payload;

      // Load every keep-folder file once, keyed by its path within the keep
      // directory. We pair delete-folder files against this map by relative
      // path. directories.path is the absolute path of the keep root.
      const keepFiles = this.loadKeepFiles(keepDirectory.directoryId);

      this.logEvent(
        "info",
        "progress_milestone",
        `Starting cleanup of ${deleteDirectories.length} directory copy${deleteDirectories.length === 1 ? "" : "ies"} ` +
          `(keeping ${keepDirectory.path})`
      );

      for (const del of deleteDirectories) {
        await this.checkPause();
        await this.cleanupOneDirectory(del, keepDirectory.path, keepFiles);
      }

      trace("directory_cleanup_end", {
        job_id: this.jobId,
        ms: Math.round(performance.now() - t0),
      });

      this.logEvent(
        "info",
        "progress_milestone",
        `Directory cleanup complete: removed ${deleteDirectories.length} directory copy${deleteDirectories.length === 1 ? "" : "ies"}`
      );
    } finally {
      if (this.releaseLock) {
        this.releaseLock();
        this.releaseLock = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-directory cleanup
  // ---------------------------------------------------------------------------

  private async cleanupOneDirectory(
    del: DirectoryDuplicateCleanupPayload["deleteDirectories"][number],
    keepRoot: string,
    keepFiles: Map<string, KeepFile>
  ): Promise<void> {
    // 1. On-disk inventory: every file on disk must be either (a) in the
    //    scan record (echoed in `del.files`) or (b) on the noise-file
    //    allowlist *and* echoed in `del.excludedFiles`. Anything else is
    //    a file the user did not review — refuse and re-scan.
    //
    //    Echoing excluded files explicitly (rather than auto-deleting any
    //    `isExcludedName` hit) keeps the "every deletion was reviewed"
    //    invariant intact even for noise files.
    const onDisk = await this.collectOnDiskFiles(del.path);
    const scanned = new Set(del.files.map((f) => f.relativePath));
    const excludedEchoed = new Set((del.excludedFiles ?? []).map((f) => f.relativePath));

    for (const rel of onDisk) {
      if (scanned.has(rel)) continue;
      if (excludedEchoed.has(rel)) {
        // Belt-and-suspenders: the route also validates this, but the gateway
        // will refuse anyway if the name doesn't match the allowlist.
        if (!isExcludedName(path.basename(rel))) {
          throw new Error(
            `Echoed excluded file "${rel}" is not on the noise-file allowlist; refusing to proceed.`
          );
        }
        continue;
      }
      throw new Error(
        `Inventory drift: ${path.join(del.path, rel)} exists on disk but was not in the reviewed deletion list. Re-scan and retry.`
      );
    }
    for (const rel of scanned) {
      if (!onDisk.has(rel)) {
        throw new Error(
          `Inventory drift: ${path.join(del.path, rel)} is in the scan but missing on disk. Re-scan and retry.`
        );
      }
    }
    for (const rel of excludedEchoed) {
      if (!onDisk.has(rel)) {
        throw new Error(
          `Inventory drift: excluded file ${path.join(del.path, rel)} was echoed but is missing on disk. Re-scan and retry.`
        );
      }
    }

    // 2. Load DB records for the delete folder's files, keyed by file_id.
    const deleteFileIds = del.files.map((f) => f.fileId);
    const deleteRecords = this.loadFilesByIds(deleteFileIds, del.directoryId);
    if (deleteRecords.size !== deleteFileIds.length) {
      throw new Error(
        `invariant: expected ${deleteFileIds.length} delete-file rows for directory ${del.directoryId}, got ${deleteRecords.size}`
      );
    }

    // 3. For every UI-echoed file, find the keep-side pair and run the
    //    per-file delete gateway. Fail-fast on any error.
    for (const f of del.files) {
      await this.checkPause();

      const deleteRecord = deleteRecords.get(f.fileId);
      if (!deleteRecord) {
        throw new Error(`invariant: delete file ${f.fileId} disappeared after batch load`);
      }
      if (deleteRecord.relativePath !== f.relativePath) {
        throw new Error(
          `Path mismatch for file ${f.fileId}: UI sent relativePath "${f.relativePath}" ` +
            `but DB has "${deleteRecord.relativePath}"`
        );
      }

      const keepFile = keepFiles.get(f.relativePath);
      if (!keepFile) {
        throw new Error(
          `No keep-folder counterpart for "${f.relativePath}" — directories are not byte-identical, re-scan and retry.`
        );
      }
      if (deleteRecord.fullHash == null || keepFile.fullHash == null) {
        throw new Error(
          `Missing full_hash for pair "${f.relativePath}" — re-scan with fullHash before cleanup.`
        );
      }
      if (deleteRecord.fullHash !== keepFile.fullHash) {
        throw new Error(
          `Full-hash mismatch for pair "${f.relativePath}" between keep and delete folders.`
        );
      }
      if (keepFile.sampledHash == null) {
        throw new Error(`invariant: keep file "${keepFile.path}" is missing sampled_hash`);
      }

      // Freshness recheck: stat + re-hash both files right now and verify all
      // three signals (size, mtime, sampled hash) still match the scan record.
      // The per-file gateway re-validates this same proof bundle before
      // unlinking.
      const deleteExpected: FileFreshness = {
        size: deleteRecord.sizeBytes,
        mtime: deleteRecord.mtime,
        sampledHash: deleteRecord.sampledHash,
      };
      const keepExpected: FileFreshness = {
        size: keepFile.sizeBytes,
        mtime: keepFile.mtime,
        sampledHash: keepFile.sampledHash,
      };
      const deleteActual = await computeFileFreshness(deleteRecord.path);
      const keepActual = await computeFileFreshness(keepFile.path);

      const deleteReason = freshnessMismatchReason(deleteExpected, deleteActual);
      if (deleteReason) {
        throw new Error(
          `Freshness drift on "${deleteRecord.path}" (${deleteReason}). Re-scan and retry.`
        );
      }
      const keepReason = freshnessMismatchReason(keepExpected, keepActual);
      if (keepReason) {
        throw new Error(
          `Freshness drift on keep file "${keepFile.path}" (${keepReason}). Re-scan and retry.`
        );
      }

      await deleteDuplicateFile({
        deletePath: deleteRecord.path,
        keepPath: keepFile.path,
        diskMountPath: this.diskMountPath,
        expectedFullHash: deleteRecord.fullHash,
        deleteFullHash: deleteRecord.fullHash,
        keepFullHash: keepFile.fullHash,
        deleteExpected,
        keepExpected,
        deleteActual,
        keepActual,
      });

      // Persist the deletion state per-file as we go so a halt midway leaves
      // the DB consistent with what's on disk: every file_id we successfully
      // unlinked has a deleted_files row.
      this.recordDeletedFile(deleteRecord.fileId);

      this.incrementProgress({
        itemsProcessed: 1,
        bytesProcessed: deleteRecord.sizeBytes,
      });
    }

    // 3b. Delete the OS noise files the UI echoed. The name-allowlist
    //     gateway re-validates the basename so a stray relativePath cannot
    //     reach unlink on anything outside the allowlist.
    for (const noise of del.excludedFiles ?? []) {
      await this.checkPause();
      const noiseAbs = path.join(del.path, noise.relativePath);
      await deleteExcludedNoiseFile({
        filePath: noiseAbs,
        diskMountPath: this.diskMountPath,
      });
      this.incrementProgress({ itemsProcessed: 1 });
    }

    // 4. Files are gone. Remove emptied directories bottom-up. Collect
    //    every descendant directory from the DB so we hit the deepest
    //    first; the gateway's rmdir will fail safely if anything unexpected
    //    remains.
    const dirsBottomUp = this.loadDescendantDirsBottomUp(del.directoryId);
    for (const dir of dirsBottomUp) {
      await removeEmptyDirectoryInsideMount({
        directoryPath: dir.path,
        diskMountPath: this.diskMountPath,
      });
    }

    // Record the directory itself as deleted now that every file is gone and
    // every emptied subdir has been rmdir'd. Re-running detection on the same
    // scan will surface this as "already deleted" without needing the per-
    // file rows.
    this.recordDeletedDirectory(del.directoryId);

    this.logEvent(
      "info",
      "progress_milestone",
      `Deleted directory copy ${del.path}`
    );
  }

  // ---------------------------------------------------------------------------
  // DB helpers
  // ---------------------------------------------------------------------------

  private loadKeepFiles(keepDirectoryId: number): Map<string, KeepFile> {
    const dirIds = this.descendantDirIds(keepDirectoryId);
    const placeholders = dirIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, path, sampled_hash, full_hash, size_bytes, mtime
         FROM files
         WHERE scan_id = ? AND directory_id IN (${placeholders})`
      )
      .all(this.scanId, ...dirIds) as Array<{
        id: number;
        path: string;
        sampled_hash: string | null;
        full_hash: string | null;
        size_bytes: number;
        mtime: string;
      }>;

    const keepRoot = this.getDirectoryPath(keepDirectoryId);
    const out = new Map<string, KeepFile>();
    for (const r of rows) {
      const rel = relativeUnder(keepRoot, r.path);
      out.set(rel, {
        fileId: r.id,
        path: r.path,
        sampledHash: r.sampled_hash,
        fullHash: r.full_hash,
        sizeBytes: r.size_bytes,
        mtime: r.mtime,
      });
    }
    return out;
  }

  private loadFilesByIds(fileIds: number[], directoryId: number): Map<number, DeleteFileRecord> {
    if (fileIds.length === 0) return new Map();
    const placeholders = fileIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, path, sampled_hash, full_hash, size_bytes, mtime
         FROM files
         WHERE scan_id = ? AND id IN (${placeholders})`
      )
      .all(this.scanId, ...fileIds) as Array<{
        id: number;
        path: string;
        sampled_hash: string | null;
        full_hash: string | null;
        size_bytes: number;
        mtime: string;
      }>;

    const root = this.getDirectoryPath(directoryId);
    const out = new Map<number, DeleteFileRecord>();
    for (const r of rows) {
      if (r.sampled_hash == null) {
        throw new Error(`invariant: file ${r.id} is missing sampled_hash`);
      }
      out.set(r.id, {
        fileId: r.id,
        path: r.path,
        relativePath: relativeUnder(root, r.path),
        sampledHash: r.sampled_hash,
        fullHash: r.full_hash,
        sizeBytes: r.size_bytes,
        mtime: r.mtime,
      });
    }
    return out;
  }

  private loadDescendantDirsBottomUp(rootDirId: number): Array<{ id: number; path: string }> {
    const dirIds = this.descendantDirIds(rootDirId);
    const placeholders = dirIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT id, path FROM directories
         WHERE scan_id = ? AND id IN (${placeholders})
         ORDER BY length(path) DESC`
      )
      .all(this.scanId, ...dirIds) as Array<{ id: number; path: string }>;
  }

  private descendantDirIds(rootId: number): number[] {
    const childDirs = this.db.prepare(
      `SELECT id FROM directories WHERE scan_id = ? AND parent_id = ?`
    );
    const ids: number[] = [rootId];
    const queue: number[] = [rootId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = childDirs.all(this.scanId, parentId) as Array<{ id: number }>;
      for (const c of children) {
        ids.push(c.id);
        queue.push(c.id);
      }
    }
    return ids;
  }

  private recordDeletedFile(fileId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)"
      )
      .run(fileId, this.scanId, now);
  }

  private recordDeletedDirectory(directoryId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO deleted_directories (directory_id, scan_id, deleted_at) VALUES (?, ?, ?)"
      )
      .run(directoryId, this.scanId, now);
  }

  private getDirectoryPath(dirId: number): string {
    const row = this.db
      .prepare("SELECT path FROM directories WHERE scan_id = ? AND id = ?")
      .get(this.scanId, dirId) as { path: string } | null;
    if (!row) {
      throw new Error(`invariant: directory ${dirId} not found in scan ${this.scanId}`);
    }
    return row.path;
  }

  // ---------------------------------------------------------------------------
  // On-disk inventory
  // ---------------------------------------------------------------------------

  /** Recursively collect every regular file under root, keyed by relative path. */
  private async collectOnDiskFiles(root: string): Promise<Set<string>> {
    const out = new Set<string>();
    const queue: Array<{ absDir: string; relDir: string }> = [{ absDir: root, relDir: "" }];
    while (queue.length > 0) {
      const { absDir, relDir } = queue.shift()!;
      const entries = await readDirectory(absDir);
      for (const e of entries) {
        const absChild = path.join(absDir, e.name);
        const relChild = relDir === "" ? e.name : `${relDir}/${e.name}`;
        if (e.isDirectory()) {
          queue.push({ absDir: absChild, relDir: relChild });
        } else if (e.isFile()) {
          out.add(relChild);
        } else {
          throw new Error(
            `Inventory drift: ${absChild} is not a regular file or directory; refusing to proceed.`
          );
        }
      }
    }
    return out;
  }
}

interface KeepFile {
  fileId: number;
  path: string;
  sampledHash: string | null;
  fullHash: string | null;
  sizeBytes: number;
  mtime: string;
}

interface DeleteFileRecord {
  fileId: number;
  path: string;
  relativePath: string;
  sampledHash: string;
  fullHash: string | null;
  sizeBytes: number;
  mtime: string;
}

function relativeUnder(rootAbs: string, fileAbs: string): string {
  // directories.path / files.path are absolute paths with no trailing slash.
  // The keep root's path is e.g. "/Volumes/X/Photos/2024"; a file inside it
  // is "/Volumes/X/Photos/2024/img/a.jpg", relative = "img/a.jpg".
  const prefix = rootAbs + "/";
  if (fileAbs === rootAbs) return "";
  if (!fileAbs.startsWith(prefix)) {
    throw new Error(`invariant: file path "${fileAbs}" is not under directory root "${rootAbs}"`);
  }
  return fileAbs.slice(prefix.length);
}
