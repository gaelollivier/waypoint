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
import { open } from "fs/promises";
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
 *   - Uses O_CREAT | O_EXCL (open flag 'wx') for atomic exclusive creation.
 *     The kernel guarantees the file is created exactly once — no TOCTOU race.
 *     Throws EEXIST if the file already exists.
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

  // Atomic exclusive create: the kernel enforces exactly-once semantics.
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — throws EEXIST if file already exists.
  let fh;
  try {
    fh = await open(dotfilePath, "wx");
  } catch (err: any) {
    if (err.code === "EEXIST") {
      throw new Error(
        `writeDiskIdDotfile: ${DISK_ID_FILENAME} already exists at ${mountPath} — use readDiskId() to read it`
      );
    }
    throw err;
  }
  try {
    await fh.writeFile(uuid + "\n");
  } finally {
    await fh.close();
  }
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
 *     Uses path.resolve() before the prefix check to neutralise `..` traversal.
 *   - Swallows all write errors — diagnostic logging must never crash the API.
 *
 * Must never be used for data that matters or backup state.
 */
export function appendToTmpLog(filePath: string, line: string): void {
  if (!path.resolve(filePath).startsWith("/tmp/")) {
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
// NOTE: createDirectory (for the copy job) is intentionally absent.
//
// It will be added here when the copy job is implemented, with an explicit
// guardrail that validates the destination path is within the target disk's
// mount point before calling mkdir. Do NOT add a version without that guard.
// ---------------------------------------------------------------------------
