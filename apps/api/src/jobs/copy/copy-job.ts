import type { Database } from "bun:sqlite";
import path from "path";
import { JobRunner } from "../job-runner";
import type { JobManager } from "../job-manager";
import { LockManager } from "../../locks/lock-manager";
import { getLockManager } from "../../locks";
import { statFile, fileExists, getDiskStats } from "../../fs/disk-reads";
import { createDirectory, copyFileAtomic, FileAlreadyExistsError } from "../../fs/disk-writes";
import { computeSampledHash, HASH_ALGO_VERSION } from "../scan/hasher";
import { recomputeAggregates } from "../scan/walker";
import { trace } from "../../diag/trace";

/** Batch size when populating copy_items from diff_entries. */
const POPULATE_BATCH_SIZE = 1000;

/** Minimum free bytes before auto-pausing during copy. */
const LOW_DISK_THRESHOLD = 500 * 1024 * 1024; // 500 MB

/** Minimum safety margin above needed bytes for the pre-flight check. */
const PREFLIGHT_MARGIN = 1024 * 1024 * 1024; // 1 GB

/** Re-check disk space every 10 minutes during copy. */
const DISK_CHECK_INTERVAL_MS = 10 * 60 * 1000;

type CopyItemStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "error_hash_mismatch"
  | "error_io"
  | "skipped_already_present"
  | "skipped_source_changed";

interface CopyItemRow {
  id: number;
  copy_job_id: number;
  source_file_id: number;
  dest_disk_id: number;
  dest_path: string;
  status: CopyItemStatus;
  bytes_copied: number;
  started_at: string | null;
  completed_at: string | null;
  error_detail: string | null;
  temp_filename: string | null;
}

interface SourceFileInfo {
  id: number;
  path: string;
  size_bytes: number;
  mtime: string;
  sampled_hash: string | null;
}

interface CopyProgress {
  totalFiles: number;
  totalBytes: number;
  copiedFiles: number;
  copiedBytes: number;
  skippedFiles: number;
  errorFiles: number;
  pendingFiles: number;
  pendingBytes: number;
  currentFile: string | null;
  currentFileBytes: number;
  currentFileBytesCopied: number;
  diskFreeBytes: number | null;
}

export class CopyJobRunner extends JobRunner {
  private db: Database;
  private sourceDiskId: number;
  private destDiskId: number;
  private diffJobId: number;
  private destMountPath: string;
  private sourceMountPath: string;
  private lockManager: LockManager;
  private releaseLock: (() => void) | null = null;

  private progress: CopyProgress = {
    totalFiles: 0,
    totalBytes: 0,
    copiedFiles: 0,
    copiedBytes: 0,
    skippedFiles: 0,
    errorFiles: 0,
    pendingFiles: 0,
    pendingBytes: 0,
    currentFile: null,
    currentFileBytes: 0,
    currentFileBytesCopied: 0,
    diskFreeBytes: null,
  };

  constructor(opts: {
    jobId: number;
    jobManager: JobManager;
    db: Database;
    sourceDiskId: number;
    destDiskId: number;
    diffJobId: number;
    destMountPath: string;
    sourceMountPath: string;
  }) {
    super(opts.jobId, opts.jobManager);
    this.db = opts.db;
    this.sourceDiskId = opts.sourceDiskId;
    this.destDiskId = opts.destDiskId;
    this.diffJobId = opts.diffJobId;
    this.destMountPath = opts.destMountPath;
    this.sourceMountPath = opts.sourceMountPath;
    this.lockManager = getLockManager();
  }

  // Override pause/resume to coordinate with the lock manager
  override pause(): void {
    this.lockManager.pause(this.destDiskId, this.jobId);
    super.pause();
  }

  override resume(): void {
    super.resume();
    this.lockManager.resume(this.destDiskId, this.jobId);
  }

  override cancel(): void {
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
    super.cancel();
  }

  protected async execute(): Promise<void> {
    trace("copy_start", {
      job_id: this.jobId,
      source_disk_id: this.sourceDiskId,
      dest_disk_id: this.destDiskId,
      diff_job_id: this.diffJobId,
    });

    const t0 = performance.now();

    // Phase A: Populate copy_items (idempotent — skipped on resume)
    await this.populateCopyItems();

    // Phase B: Pre-flight disk space check
    await this.preflightDiskCheck();

    // Phase C: Copy loop
    this.releaseLock = await this.lockManager.acquire(this.destDiskId, this.jobId);
    try {
      await this.copyLoop();
    } finally {
      if (this.releaseLock) {
        this.releaseLock();
        this.releaseLock = null;
      }
    }

    // Post-copy: recompute directory aggregates on dest disk's latest scan
    const destScanRow = this.db
      .prepare("SELECT last_scan_job_id FROM disks WHERE id = ?")
      .get(this.destDiskId) as { last_scan_job_id: number | null } | null;
    if (destScanRow?.last_scan_job_id) {
      await recomputeAggregates(this.db, destScanRow.last_scan_job_id);
    }

    trace("copy_end", {
      job_id: this.jobId,
      ms: Math.round(performance.now() - t0),
      copied: this.progress.copiedFiles,
      skipped: this.progress.skippedFiles,
      errors: this.progress.errorFiles,
    });

    this.logEvent(
      "info",
      "progress_milestone",
      `Copy complete: ${this.progress.copiedFiles} copied, ${this.progress.skippedFiles} skipped, ${this.progress.errorFiles} errors`
    );
  }

  // -------------------------------------------------------------------------
  // Phase A: Populate copy_items from diff_entries
  // -------------------------------------------------------------------------

  private async populateCopyItems(): Promise<void> {
    const existing = this.db
      .prepare("SELECT COUNT(*) AS n FROM copy_items WHERE copy_job_id = ?")
      .get(this.jobId) as { n: number };

    if (existing.n > 0) {
      // Resume path: copy_items already populated.
      // Reset any in_progress items to pending (they were interrupted).
      this.resetInProgressItems();
      this.loadProgressCounters();
      return;
    }

    // Fresh start: populate from diff_entries
    const entries = this.db
      .prepare(
        `SELECT de.source_file_id, de.path, f.size_bytes
         FROM diff_entries de
         JOIN files f ON f.id = de.source_file_id
         WHERE de.diff_job_id = ? AND de.kind IN ('added', 'changed')`
      )
      .all(this.diffJobId) as Array<{
        source_file_id: number;
        path: string;
        size_bytes: number;
      }>;

    const insertStmt = this.db.prepare(
      `INSERT INTO copy_items (copy_job_id, source_file_id, dest_disk_id, dest_path, status)
       VALUES (?, ?, ?, ?, 'pending')`
    );

    let totalBytes = 0;
    for (let i = 0; i < entries.length; i += POPULATE_BATCH_SIZE) {
      const batch = entries.slice(i, i + POPULATE_BATCH_SIZE);
      this.db.transaction(() => {
        for (const entry of batch) {
          insertStmt.run(this.jobId, entry.source_file_id, this.destDiskId, entry.path);
          totalBytes += entry.size_bytes;
        }
      })();
      await this.checkPause();
      await new Promise<void>((r) => setImmediate(r));
    }

    this.progress.totalFiles = entries.length;
    this.progress.totalBytes = totalBytes;
    this.progress.pendingFiles = entries.length;
    this.progress.pendingBytes = totalBytes;
    this.broadcastProgress();

    this.logEvent(
      "info",
      "progress_milestone",
      `Prepared ${entries.length} files to copy (${formatBytes(totalBytes)})`
    );
  }

  private resetInProgressItems(): void {
    const inProgressItems = this.db
      .prepare(
        "SELECT id, temp_filename FROM copy_items WHERE copy_job_id = ? AND status = 'in_progress'"
      )
      .all(this.jobId) as Array<{ id: number; temp_filename: string | null }>;

    for (const item of inProgressItems) {
      if (item.temp_filename) {
        this.logEvent(
          "warning",
          "orphan_temp",
          `Orphaned temp file from interrupted copy: ${item.temp_filename}`,
          { copyItemId: item.id, tempFilename: item.temp_filename }
        );
      }
      this.db
        .prepare(
          `UPDATE copy_items
           SET status = 'pending', started_at = NULL, bytes_copied = 0, temp_filename = NULL
           WHERE id = ?`
        )
        .run(item.id);
    }

    if (inProgressItems.length > 0) {
      this.logEvent(
        "info",
        "resume",
        `Reset ${inProgressItems.length} interrupted item(s) to pending`
      );
    }
  }

  private loadProgressCounters(): void {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status IN ('skipped_already_present', 'skipped_source_changed') THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN status IN ('error_hash_mismatch', 'error_io') THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN f.size_bytes ELSE 0 END), 0) AS pending_bytes
         FROM copy_items ci
         JOIN files f ON f.id = ci.source_file_id
         WHERE ci.copy_job_id = ?`
      )
      .get(this.jobId) as {
        total: number;
        done: number;
        skipped: number;
        errors: number;
        pending: number;
        pending_bytes: number;
      };

    const byteTotals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(f.size_bytes), 0) AS total_bytes,
           COALESCE(SUM(CASE WHEN ci.status = 'done' THEN ci.bytes_copied ELSE 0 END), 0) AS copied_bytes
         FROM copy_items ci
         JOIN files f ON f.id = ci.source_file_id
         WHERE ci.copy_job_id = ?`
      )
      .get(this.jobId) as { total_bytes: number; copied_bytes: number };

    this.progress.totalFiles = counts.total;
    this.progress.totalBytes = byteTotals.total_bytes;
    this.progress.copiedFiles = counts.done;
    this.progress.copiedBytes = byteTotals.copied_bytes;
    this.progress.skippedFiles = counts.skipped;
    this.progress.errorFiles = counts.errors;
    this.progress.pendingFiles = counts.pending;
    this.progress.pendingBytes = counts.pending_bytes;
    this.broadcastProgress();
  }

  // -------------------------------------------------------------------------
  // Phase B: Pre-flight disk space check
  // -------------------------------------------------------------------------

  private async preflightDiskCheck(): Promise<void> {
    const pendingBytes = this.db
      .prepare(
        `SELECT COALESCE(SUM(f.size_bytes), 0) AS total
         FROM copy_items ci
         JOIN files f ON f.id = ci.source_file_id
         WHERE ci.copy_job_id = ? AND ci.status = 'pending'`
      )
      .get(this.jobId) as { total: number };

    const stats = getDiskStats(this.destMountPath);
    this.progress.diskFreeBytes = stats.freeBytes;

    if (stats.freeBytes !== null && pendingBytes.total > 0) {
      const needed = pendingBytes.total + PREFLIGHT_MARGIN;
      if (stats.freeBytes < needed) {
        const msg = `Insufficient disk space: need ${formatBytes(needed)}, have ${formatBytes(stats.freeBytes)}`;
        this.logEvent("error", "disk_space", msg);
        throw new Error(msg);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase C: Copy loop
  // -------------------------------------------------------------------------

  private async copyLoop(): Promise<void> {
    let lastDiskCheckTime = Date.now();

    while (true) {
      // Pause checkpoint (with lock coordination via overridden pause/resume)
      await this.checkPause();

      // Fetch next pending item
      const item = this.db
        .prepare(
          `SELECT ci.*, f.path AS source_path, f.size_bytes, f.mtime, f.sampled_hash
           FROM copy_items ci
           JOIN files f ON f.id = ci.source_file_id
           WHERE ci.copy_job_id = ? AND ci.status = 'pending'
           ORDER BY ci.id ASC
           LIMIT 1`
        )
        .get(this.jobId) as (CopyItemRow & {
          source_path: string;
          size_bytes: number;
          mtime: string;
          sampled_hash: string | null;
        }) | null;

      if (!item) break; // All items processed

      this.progress.currentFile = item.dest_path;
      this.progress.currentFileBytes = item.size_bytes;
      this.progress.currentFileBytesCopied = 0;
      this.broadcastProgress();

      try {
        await this.copyOneFile(item);
      } catch (err) {
        // Unexpected error — mark as error_io and continue
        const message = err instanceof Error ? err.message : String(err);
        this.markItemStatus(item.id, "error_io", message);
        this.progress.errorFiles++;
        this.progress.pendingFiles--;
        this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
        this.incrementProgress({
          itemsProcessed: 1,
          errorsCount: 1,
          progressJson: this.progress,
        });
        this.logEvent("error", "copy_error", `Error copying ${item.dest_path}: ${message}`, {
          copyItemId: item.id,
          destPath: item.dest_path,
        });
      }

      // Yield to event loop between files
      await new Promise<void>((r) => setImmediate(r));

      // Periodic disk space check (every 10 min)
      if (Date.now() - lastDiskCheckTime > DISK_CHECK_INTERVAL_MS) {
        lastDiskCheckTime = Date.now();
        await this.periodicDiskCheck();
      }
    }

    this.progress.currentFile = null;
    this.progress.currentFileBytes = 0;
    this.progress.currentFileBytesCopied = 0;
    this.broadcastProgress();
  }

  private async copyOneFile(
    item: CopyItemRow & {
      source_path: string;
      size_bytes: number;
      mtime: string;
      sampled_hash: string | null;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    const tempSuffix = crypto.randomUUID();

    // Mark in_progress and store temp filename
    this.db
      .prepare(
        `UPDATE copy_items
         SET status = 'in_progress', started_at = ?, temp_filename = ?
         WHERE id = ?`
      )
      .run(now, `${path.basename(item.dest_path)}.backup-tmp-${tempSuffix}`, item.id);

    // Step 1: Source re-stat — verify the file hasn't changed since scan
    let currentStat;
    try {
      currentStat = await statFile(item.source_path);
    } catch (err) {
      const msg = `Cannot stat source file: ${err instanceof Error ? err.message : String(err)}`;
      this.markItemStatus(item.id, "error_io", msg);
      this.progress.errorFiles++;
      this.progress.pendingFiles--;
      this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
      this.incrementProgress({
        itemsProcessed: 1,
        errorsCount: 1,
        progressJson: this.progress,
      });
      return;
    }

    const storedMtime = new Date(item.mtime).getTime();
    const currentMtime = currentStat.mtime.getTime();

    if (currentStat.size !== item.size_bytes || currentMtime !== storedMtime) {
      this.markItemStatus(
        item.id,
        "skipped_source_changed",
        `Source file changed since scan: size ${item.size_bytes}→${currentStat.size}, mtime ${item.mtime}→${currentStat.mtime.toISOString()}`
      );
      this.progress.skippedFiles++;
      this.progress.pendingFiles--;
      this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
      this.incrementProgress({
        itemsProcessed: 1,
        nonCriticalErrorsCount: 1,
        progressJson: this.progress,
      });
      this.logEvent("warning", "source_changed", `Source file changed since scan: ${item.dest_path}`, {
        destPath: item.dest_path,
        expectedSize: item.size_bytes,
        actualSize: currentStat.size,
      });
      return;
    }

    // Step 2: Source re-hash — verify sampled hash still matches
    if (item.sampled_hash) {
      const currentHash = await computeSampledHash(item.source_path, currentStat.size);
      if (currentHash !== item.sampled_hash) {
        this.markItemStatus(
          item.id,
          "skipped_source_changed",
          `Source file hash changed since scan: ${item.sampled_hash} → ${currentHash}`
        );
        this.progress.skippedFiles++;
        this.progress.pendingFiles--;
        this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
        this.incrementProgress({
          itemsProcessed: 1,
          nonCriticalErrorsCount: 1,
          progressJson: this.progress,
        });
        this.logEvent("warning", "source_changed", `Source file hash changed since scan: ${item.dest_path}`);
        return;
      }
    }

    // Step 3: Dest existence check
    const destAbsPath = path.join(this.destMountPath, item.dest_path);
    if (await fileExists(destAbsPath)) {
      // File already exists at dest — hash it and compare
      const destHash = await computeSampledHash(destAbsPath, currentStat.size);
      if (item.sampled_hash && destHash === item.sampled_hash) {
        this.markItemStatus(item.id, "skipped_already_present", null);
        this.progress.skippedFiles++;
        this.progress.pendingFiles--;
        this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
        this.incrementProgress({
          itemsProcessed: 1,
          progressJson: this.progress,
        });
        return;
      }

      // Hash mismatch — never overwrite
      this.markItemStatus(
        item.id,
        "error_hash_mismatch",
        `Dest file exists with different hash: source=${item.sampled_hash}, dest=${destHash}`
      );
      this.progress.errorFiles++;
      this.progress.pendingFiles--;
      this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
      this.incrementProgress({
        itemsProcessed: 1,
        errorsCount: 1,
        progressJson: this.progress,
      });
      this.logEvent("error", "hash_mismatch", `File exists at dest with different hash: ${item.dest_path}`, {
        destPath: item.dest_path,
        sourceHash: item.sampled_hash,
        destHash,
      });
      return;
    }

    // Step 4: Create parent directory on dest
    const parentDir = path.dirname(item.dest_path);
    if (parentDir && parentDir !== "/" && parentDir !== ".") {
      await createDirectory(this.destMountPath, parentDir);
    }

    // Step 5: Copy file with atomic temp→rename and inline full hash
    let copyBytesAccumulator = 0;
    const result = await copyFileAtomic({
      sourcePath: item.source_path,
      destMountPath: this.destMountPath,
      destRelativePath: item.dest_path,
      tempSuffix,
      onChunkWritten: (bytes) => {
        copyBytesAccumulator += bytes;
        this.progress.currentFileBytesCopied = copyBytesAccumulator;
        // Report chunk-level progress for large files
        this.incrementProgress({
          bytesProcessed: bytes,
          progressJson: {
            ...this.progress,
            copiedBytes: this.progress.copiedBytes + copyBytesAccumulator,
          },
        });
      },
    });

    // Step 6: Mark done, update hashes, upsert dest files row
    this.markItemStatus(item.id, "done", null, result.bytesWritten);

    // Update full_hash on the source files row (computed for free during copy)
    this.db
      .prepare("UPDATE files SET full_hash = ? WHERE id = ?")
      .run(result.fullHash, item.source_file_id);

    // Upsert dest files row so the dest disk index stays current
    await this.upsertDestFile(item, result.fullHash);

    this.progress.copiedFiles++;
    this.progress.copiedBytes += result.bytesWritten;
    this.progress.pendingFiles--;
    this.progress.pendingBytes = Math.max(0, this.progress.pendingBytes - item.size_bytes);
    this.progress.currentFileBytesCopied = 0;
    this.incrementProgress({
      itemsProcessed: 1,
      // Don't double-count bytes — chunks already reported them
      bytesProcessed: 0,
      progressJson: this.progress,
    });
  }

  // -------------------------------------------------------------------------
  // Dest file upsert
  // -------------------------------------------------------------------------

  private async upsertDestFile(
    item: CopyItemRow & { source_path: string; size_bytes: number; sampled_hash: string | null },
    fullHash: string
  ): Promise<void> {
    const destAbsPath = path.join(this.destMountPath, item.dest_path);
    const destStat = await statFile(destAbsPath);
    const fileName = path.basename(item.dest_path);
    // The directories table stores absolute paths (set by the scanner), so
    // convert the relative dir path to absolute for lookups.
    const dirRelPath = path.dirname(item.dest_path);
    const dirAbsPath = dirRelPath === "/" || dirRelPath === "."
      ? this.destMountPath
      : path.join(this.destMountPath, dirRelPath);

    // Resolve the dest disk's latest scan_id for directory/file lookups
    const destScanRow = this.db
      .prepare("SELECT last_scan_job_id FROM disks WHERE id = ?")
      .get(this.destDiskId) as { last_scan_job_id: number | null } | null;
    if (!destScanRow?.last_scan_job_id) throw new Error("invariant: dest disk has no completed scan");
    const destScanId = destScanRow.last_scan_job_id;

    // Find or create directory on dest disk
    const dirRow = this.db
      .prepare("SELECT id FROM directories WHERE scan_id = ? AND path = ?")
      .get(destScanId, dirAbsPath) as { id: number } | null;

    // If the directory doesn't exist in our DB yet, create it
    let directoryId: number;
    if (dirRow) {
      directoryId = dirRow.id;
    } else {
      directoryId = this.ensureDirectoryChain(dirRelPath);
    }

    // Upsert the file row
    this.db
      .prepare(
        `INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scan_id, path) DO UPDATE SET
           directory_id = excluded.directory_id,
           name = excluded.name,
           size_bytes = excluded.size_bytes,
           mtime = excluded.mtime,
           sampled_hash = excluded.sampled_hash,
           full_hash = excluded.full_hash,
           hash_algo_version = excluded.hash_algo_version`
      )
      .run(
        this.destDiskId,
        destScanId,
        directoryId,
        fileName,
        destAbsPath,
        destStat.size,
        destStat.mtime.toISOString(),
        item.sampled_hash,
        fullHash,
        HASH_ALGO_VERSION,
      );
  }

  /**
   * Ensures the full directory chain exists in the `directories` table for the
   * dest disk. Returns the leaf directory's id.
   *
   * The directories table stores absolute paths (set by the scanner), so we
   * convert each segment to its absolute form for both lookups and inserts.
   */
  private ensureDirectoryChain(relativePath: string): number {
    // Resolve the dest disk's latest scan_id
    const destScanRow = this.db
      .prepare("SELECT last_scan_job_id FROM disks WHERE id = ?")
      .get(this.destDiskId) as { last_scan_job_id: number | null } | null;
    if (!destScanRow?.last_scan_job_id) throw new Error("invariant: dest disk has no completed scan");
    const destScanId = destScanRow.last_scan_job_id;

    const segments = relativePath === "/" || relativePath === "."
      ? ["/"]
      : ["/" , ...relativePath.split("/").filter(Boolean)];

    let parentId: number | null = null;
    let currentRelPath = "";

    for (const segment of segments) {
      if (segment === "/") {
        currentRelPath = "/";
      } else {
        currentRelPath = currentRelPath === "/" ? `/${segment}` : `${currentRelPath}/${segment}`;
      }

      // The scanner stores absolute paths, so convert for DB lookups/inserts
      const absPath = currentRelPath === "/"
        ? this.destMountPath
        : path.join(this.destMountPath, currentRelPath);

      const existing = this.db
        .prepare("SELECT id FROM directories WHERE scan_id = ? AND path = ?")
        .get(destScanId, absPath) as { id: number } | null;

      if (existing) {
        parentId = existing.id;
        continue;
      }

      const row = this.db
        .prepare(
          `INSERT INTO directories (disk_id, scan_id, parent_id, name, path)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id`
        )
        .get(
          this.destDiskId,
          destScanId,
          parentId,
          segment === "/" ? path.basename(this.destMountPath) : segment,
          absPath
        ) as { id: number };

      parentId = row.id;
    }

    if (parentId === null) {
      throw new Error("invariant: ensureDirectoryChain produced no directory — segments was empty");
    }
    return parentId;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private markItemStatus(
    itemId: number,
    status: CopyItemStatus,
    errorDetail: string | null,
    bytesCopied?: number
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE copy_items
         SET status = ?, completed_at = ?, error_detail = ?,
             bytes_copied = CASE WHEN ? IS NOT NULL THEN ? ELSE bytes_copied END
         WHERE id = ?`
      )
      .run(status, now, errorDetail, bytesCopied ?? null, bytesCopied ?? 0, itemId);
  }

  private async periodicDiskCheck(): Promise<void> {
    const stats = getDiskStats(this.destMountPath);
    this.progress.diskFreeBytes = stats.freeBytes;

    if (stats.freeBytes !== null && stats.freeBytes < LOW_DISK_THRESHOLD) {
      this.logEvent(
        "warning",
        "disk_space",
        `Low disk space: ${formatBytes(stats.freeBytes)} remaining — auto-pausing`
      );
      // Self-pause: the lock manager pause happens via the overridden pause()
      this.pause();
    }
  }

  private broadcastProgress(): void {
    this.incrementProgress({ progressJson: this.progress });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
