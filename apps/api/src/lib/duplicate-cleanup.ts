/**
 * Single-group duplicate cleanup, extracted so both the manual cleanup
 * endpoint and the batch-suggestion apply endpoint share one validated
 * implementation.
 *
 * What this module does NOT do: enforce the browser-UA / initiatedFromWebUI
 * guardrails (route-level), acquire the disk write lock (caller-level),
 * or write to the job event log (caller-level). The caller owns those so
 * a batch apply can acquire the lock once and log one summary event.
 *
 * What it DOES do: validate one (duplicateGroupId, keepFile, deleteFiles)
 * triple against the DB, recompute freshness, call the deletion gateway
 * for each file, and persist `deleted_files` rows for the deletes that
 * landed. Halts on the first delete failure within the group, returning
 * the partial result and the failure record.
 */

import type { Database } from "bun:sqlite";
import { deleteDuplicateFile } from "../fs/disk-writes";
import {
  computeFileFreshness,
  freshnessMismatchReason,
  type FileFreshness,
} from "./freshness";
import { recordAudit, type Actor } from "./audit";

export class CleanupValidationError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface CleanupGroupInput {
  duplicateGroupId: number;
  keepFile: { fileId: number; path: string };
  deleteFiles: Array<{ fileId: number; path: string }>;
  /**
   * Optional audit context. When provided, every successful deletion gets a
   * row in `audit_log` capturing enough state to revert (restore from the
   * kept copy). Callers that don't pass this still write `deleted_files`
   * rows but skip the audit_log row — used for internal/system flows that
   * already have their own audit story.
   */
  audit?: {
    actor: Actor;
    userAgent?: string | null;
    /** Extra metadata to merge into each audit row, e.g. suggestionId. */
    extraMetadata?: Record<string, unknown>;
  };
}

export interface CleanupGroupResult {
  duplicateGroupId: number;
  keepFileId: number;
  deletedCount: number;
  results: Array<{ fileId: number; path: string; status: "deleted" }>;
  /** Set when a delete failed mid-loop; the remaining members were skipped. */
  failedAt: { fileId: number; path: string; error: string } | null;
}

interface DiskContext {
  diskId: number;
  diskMountPath: string;
}

/**
 * Validates one cleanup request against the DB, re-checks freshness on
 * disk, then deletes each file in `deleteFiles` while the keep file is
 * preserved. Persists `deleted_files` rows for the deletes that succeeded
 * before any halt.
 *
 * Caller must already hold the disk write lock.
 *
 * Throws `CleanupValidationError` for any pre-deletion check that fails.
 */
export async function applyDuplicateCleanup(
  db: Database,
  disk: DiskContext,
  input: CleanupGroupInput
): Promise<CleanupGroupResult> {
  const { duplicateGroupId, keepFile, deleteFiles } = input;

  if (!Number.isInteger(duplicateGroupId) || duplicateGroupId <= 0) {
    throw new CleanupValidationError("Invalid duplicateGroupId", 400);
  }
  if (
    !keepFile ||
    !Number.isInteger(keepFile.fileId) ||
    keepFile.fileId <= 0 ||
    typeof keepFile.path !== "string"
  ) {
    throw new CleanupValidationError(
      "Invalid keepFile — must include fileId and path",
      400
    );
  }
  if (!Array.isArray(deleteFiles) || deleteFiles.length === 0) {
    throw new CleanupValidationError("deleteFiles must be a non-empty array", 400);
  }
  if (
    deleteFiles.some(
      (f) => !Number.isInteger(f.fileId) || f.fileId <= 0 || typeof f.path !== "string"
    )
  ) {
    throw new CleanupValidationError(
      "All deleteFiles entries must include fileId and path",
      400
    );
  }

  const keepFileId = keepFile.fileId;
  const deleteFileIds = deleteFiles.map((f) => f.fileId);

  if (deleteFileIds.includes(keepFileId)) {
    throw new CleanupValidationError("keepFile must not appear in deleteFiles", 400);
  }

  // Group validation: exists, on this disk, completed job, full-hash kind.
  const group = db
    .prepare(
      `SELECT dg.id, dg.hash_kind, dg.content_hash, dg.sampled_hash, dg.file_count,
              dg.duplicate_job_id, j.payload_json
       FROM duplicate_groups dg
       JOIN jobs j ON j.id = dg.duplicate_job_id
       WHERE dg.id = ?
         AND j.target_disk_id = ?
         AND j.status = 'completed'`
    )
    .get(duplicateGroupId, disk.diskId) as {
      id: number;
      hash_kind: "full" | "sampled";
      content_hash: string;
      sampled_hash: string;
      file_count: number;
      duplicate_job_id: number;
      payload_json: string | null;
    } | null;

  if (!group) {
    throw new CleanupValidationError(
      "Duplicate group not found or does not belong to a completed job for this disk",
      404
    );
  }
  if (group.hash_kind !== "full") {
    throw new CleanupValidationError(
      "Duplicate cleanup requires full-hash-backed duplicate groups",
      409
    );
  }
  if (!group.payload_json) {
    throw new Error(`invariant: duplicate group ${duplicateGroupId} job missing payload_json`);
  }
  const payload = JSON.parse(group.payload_json) as { scanId?: number };
  if (!Number.isInteger(payload.scanId)) {
    throw new Error(`invariant: duplicate group ${duplicateGroupId} job payload missing scanId`);
  }
  const selectedScanId = payload.scanId as number;

  // File membership + sent-path-vs-DB-path consistency.
  const allFileIds = [keepFileId, ...deleteFileIds];
  const placeholders = allFileIds.map(() => "?").join(", ");
  const groupFiles = db
    .prepare(
      `SELECT dgf.file_id, dgf.path, f.scan_id, f.sampled_hash, f.full_hash, f.size_bytes, f.mtime
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
      mtime: string;
    }>;

  const fileMap = new Map(groupFiles.map((f) => [f.file_id, f]));

  for (const fileId of allFileIds) {
    if (!fileMap.has(fileId)) {
      throw new CleanupValidationError(
        `File ${fileId} is not a member of duplicate group ${duplicateGroupId}`,
        400
      );
    }
  }

  const sentFiles = [keepFile, ...deleteFiles];
  for (const sent of sentFiles) {
    const dbFile = fileMap.get(sent.fileId);
    if (!dbFile) throw new Error(`invariant: file ${sent.fileId} disappeared from fileMap after validation`);
    if (dbFile.path !== sent.path) {
      throw new CleanupValidationError(
        `Path mismatch for file ${sent.fileId}: caller sent "${sent.path}" but DB has "${dbFile.path}"`,
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
      throw new CleanupValidationError(
        `Stored full hash mismatch for file ${file.file_id}; refusing to delete`,
        409
      );
    }
    if (file.sampled_hash == null) {
      throw new Error(`invariant: full-hash duplicate file ${file.file_id} is missing sampled_hash`);
    }
  }

  if (deleteFileIds.length >= group.file_count) {
    throw new CleanupValidationError(
      "Cannot delete all copies — at least one must remain",
      400
    );
  }

  // Freshness recheck against disk for every keep + delete file.
  const currentFreshness = new Map<number, FileFreshness>();
  const expectedFreshness = new Map<number, FileFreshness>();
  for (const fileId of allFileIds) {
    const file = fileMap.get(fileId);
    if (!file) throw new Error(`invariant: file ${fileId} disappeared from fileMap before recheck`);
    if (file.sampled_hash == null) {
      throw new Error(`invariant: full-hash duplicate file ${file.file_id} is missing sampled_hash`);
    }

    const expected: FileFreshness = {
      size: file.size_bytes,
      mtime: file.mtime,
      sampledHash: file.sampled_hash,
    };
    expectedFreshness.set(fileId, expected);

    let actual: FileFreshness;
    try {
      actual = await computeFileFreshness(file.path);
    } catch (err: any) {
      throw new CleanupValidationError(
        `Could not re-check file ${fileId} before deletion: ${err.message}`,
        409
      );
    }
    currentFreshness.set(fileId, actual);

    const reason = freshnessMismatchReason(expected, actual);
    if (reason) {
      throw new CleanupValidationError(
        `File ${fileId} no longer matches the selected scan (${reason}); rerun duplicate detection before deleting`,
        409
      );
    }
  }

  // Per-file deletion loop. Fail-fast: the first failure halts the loop;
  // already-deleted files are still persisted to deleted_files so the DB
  // matches disk reality.
  const keepRecord = fileMap.get(keepFileId);
  if (!keepRecord) throw new Error(`invariant: keep file ${keepFileId} missing before deletion`);
  const keepActual = currentFreshness.get(keepFileId);
  const keepExpected = expectedFreshness.get(keepFileId);
  if (!keepActual || !keepExpected) {
    throw new Error(`invariant: keep file ${keepFileId} missing freshness record`);
  }

  const results: Array<{ fileId: number; path: string; status: "deleted" }> = [];
  let failedAt: { fileId: number; path: string; error: string } | null = null;

  for (const fileId of deleteFileIds) {
    const deleteRecord = fileMap.get(fileId);
    if (!deleteRecord) throw new Error(`invariant: delete file ${fileId} missing before deletion`);
    const deleteActual = currentFreshness.get(fileId);
    const deleteExpected = expectedFreshness.get(fileId);
    if (!deleteActual || !deleteExpected) {
      throw new Error(`invariant: delete file ${fileId} missing freshness record`);
    }

    try {
      await deleteDuplicateFile({
        deletePath: deleteRecord.path,
        keepPath: keepRecord.path,
        diskMountPath: disk.diskMountPath,
        expectedFullHash: group.content_hash,
        deleteFullHash: deleteRecord.full_hash!,
        keepFullHash: keepRecord.full_hash!,
        deleteExpected,
        keepExpected,
        deleteActual,
        keepActual,
      });
      results.push({ fileId, path: deleteRecord.path, status: "deleted" });
    } catch (err: any) {
      failedAt = { fileId, path: deleteRecord.path, error: err.message };
      break;
    }
  }

  // Persist deleted_files for the deletes that landed, and write audit rows
  // when the caller provided audit context.
  if (results.length > 0) {
    const now = new Date().toISOString();
    const recordDeleted = db.prepare(
      "INSERT OR REPLACE INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)"
    );
    db.transaction(() => {
      for (const r of results) {
        recordDeleted.run(r.fileId, selectedScanId, now);
        if (input.audit) {
          const file = fileMap.get(r.fileId);
          if (!file) throw new Error(`invariant: deleted file ${r.fileId} missing from fileMap`);
          recordAudit(db, {
            action: "duplicate_cleanup",
            actor: input.audit.actor,
            userAgent: input.audit.userAgent,
            diskId: disk.diskId,
            targetKind: "file",
            targetId: r.fileId,
            targetPath: r.path,
            before: {
              fileId: r.fileId,
              path: r.path,
              sizeBytes: file.size_bytes,
              mtime: file.mtime,
              sampledHash: file.sampled_hash,
              fullHash: file.full_hash,
              scanId: file.scan_id,
              keptFile: {
                fileId: keepRecord.file_id,
                path: keepRecord.path,
                fullHash: keepRecord.full_hash,
              },
            },
            metadata: {
              duplicateGroupId,
              duplicateJobId: group.duplicate_job_id,
              ...input.audit.extraMetadata,
            },
          });
        }
      }
    })();
  }

  return {
    duplicateGroupId,
    keepFileId,
    deletedCount: results.length,
    results,
    failedAt,
  };
}

/**
 * Looks up the duplicate-detection job that owns a given group. Useful for
 * callers that hold a disk write lock referencing this job id.
 */
export function getDuplicateGroupJobId(
  db: Database,
  duplicateGroupId: number
): number | null {
  const row = db
    .prepare(`SELECT duplicate_job_id FROM duplicate_groups WHERE id = ?`)
    .get(duplicateGroupId) as { duplicate_job_id: number } | null;
  return row?.duplicate_job_id ?? null;
}
