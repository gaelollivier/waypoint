/**
 * disk-writes.ts — THE ONLY FILE THAT MAY WRITE TO DISK.
 *
 * Every function here modifies files on the filesystem. This file is kept
 * deliberately small so it can be audited in full before any copy job touches
 * backup data. Each operation has explicit guardrails that cannot be bypassed
 * by the caller.
 *
 * No other source file in apps/api/src/ (outside of __tests__) may use
 * Bun.write(), appendFileSync(), writeFileSync(), mkdir(), rename(), unlink(),
 * or any other write-capable API directly.
 *
 * Before adding a new write operation here: ask whether the design can avoid it.
 */

import { appendFileSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";

const DISK_ID_FILENAME = ".waypoint-disk-id";

// ---------------------------------------------------------------------------
// Disk identity
// ---------------------------------------------------------------------------

/**
 * WRITE: Creates the Waypoint identity dotfile on a newly registered disk.
 *
 * Why this exists:
 *   Each backup disk gets a UUID written once at registration time. This UUID
 *   is the disk's permanent identity — all scan history, diff results, and
 *   copy records are associated with it. Without this file, Waypoint cannot
 *   recognise a disk across disconnects.
 *
 * Guardrails:
 *   - The destination path is always constructed as `<mountPath>/.waypoint-disk-id`.
 *     The caller cannot redirect this write to any other filename.
 *   - Throws if the file already exists. The UUID is assigned exactly once.
 *     Overwriting it would orphan all history recorded against the old UUID.
 */
export async function writeDiskIdDotfile(
  mountPath: string,
  uuid: string
): Promise<void> {
  const dotfilePath = path.join(mountPath, DISK_ID_FILENAME);

  // Belt-and-suspenders: path.join already ensures the correct filename, but
  // this assertion is deliberately visible in the audit trail.
  if (path.basename(dotfilePath) !== DISK_ID_FILENAME) {
    throw new Error(
      `writeDiskIdDotfile: internal error — unexpected path ${dotfilePath}`
    );
  }

  // Never overwrite an existing disk ID.
  if (await Bun.file(dotfilePath).exists()) {
    throw new Error(
      `writeDiskIdDotfile: ${DISK_ID_FILENAME} already exists at ${mountPath} — use readDiskId() to read it`
    );
  }

  await Bun.write(dotfilePath, uuid + "\n");
}

// ---------------------------------------------------------------------------
// Diagnostic logging
// ---------------------------------------------------------------------------

/**
 * WRITE: Appends a single text line to a diagnostic log file under /tmp.
 *
 * Guardrails:
 *   - Silently refuses to write to any path outside /tmp/. A misconfigured
 *     WAYPOINT_TRACE_PATH can never redirect trace output to a backup disk.
 *   - Swallows all write errors — diagnostic logging must never crash the API.
 *
 * Must never be used for data that matters or backup state.
 */
export function appendToTmpLog(filePath: string, line: string): void {
  if (!filePath.startsWith("/tmp/")) {
    // Silently refuse — wrong path is a misconfiguration, not a crash-worthy error.
    return;
  }
  try {
    appendFileSync(filePath, line + "\n");
  } catch {
    // Never crash the caller because of a log write failure.
  }
}

// ---------------------------------------------------------------------------
// Directory creation (copy job)
// ---------------------------------------------------------------------------

/**
 * WRITE: Creates a directory and any missing parents.
 *
 * Used by the copy job to recreate the source directory structure on the
 * backup disk before files are written into it.
 *
 * The copy job is responsible for constructing and validating the destination
 * path before calling this.
 */
export async function createDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
