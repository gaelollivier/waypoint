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

import { appendFileSync, mkdirSync } from "fs";
import { mkdir, open, rename } from "fs/promises";
import path from "path";
import { readFileStream } from "./disk-io";
import { createStreamingHasher, finaliseHash } from "../jobs/scan/hasher";

/** Yield to the event loop every 64 MB during streaming copies. */
const YIELD_EVERY_BYTES = 64 * 1024 * 1024;

const DISK_ID_FILENAME = ".waypoint-disk-id";

// ---------------------------------------------------------------------------
// Host application data
// ---------------------------------------------------------------------------

/**
 * WRITE: Creates Waypoint's host-side application data directory.
 *
 * Guardrails:
 *   - The caller cannot choose the path. It is always `$HOME/.waypoint`.
 *   - The basename is asserted before mkdir so a future refactor cannot
 *     silently redirect this helper to an unexpected directory.
 *   - This is for host metadata storage, not backup-disk content.
 */
export function createWaypointDataDirectory(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("createWaypointDataDirectory: HOME is not set");
  }

  const dirPath = path.join(home, ".waypoint");
  if (path.basename(dirPath) !== ".waypoint") {
    throw new Error(
      `createWaypointDataDirectory: internal error — unexpected path ${dirPath}`
    );
  }

  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

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
// Directory creation (for the copy job)
// ---------------------------------------------------------------------------

/**
 * WRITE: Creates a directory (and intermediate parents) on a backup disk.
 *
 * Guardrails:
 *   - The absolute path must resolve within destMountPath. Throws if path
 *     traversal (e.g. via ".." segments) would escape the disk mount.
 *   - Uses `recursive: true` so this is idempotent — safe to call on every
 *     file copy even if the directory already exists.
 */
export async function createDirectory(
  destMountPath: string,
  relativePath: string
): Promise<void> {
  const absolutePath = path.join(destMountPath, relativePath);
  if (!path.resolve(absolutePath).startsWith(path.resolve(destMountPath))) {
    throw new Error(
      `createDirectory: path "${relativePath}" escapes disk mount "${destMountPath}"`
    );
  }
  await mkdir(absolutePath, { recursive: true });
}

// ---------------------------------------------------------------------------
// Atomic file copy with inline hashing (for the copy job)
// ---------------------------------------------------------------------------

/** Thrown when the destination file already exists. */
export class FileAlreadyExistsError extends Error {
  constructor(destPath: string) {
    super(`File already exists at destination: ${destPath}`);
    this.name = "FileAlreadyExistsError";
  }
}

/**
 * WRITE: Copies a file from source to dest using the temp→rename pattern,
 * computing a full BLAKE3 hash inline during the streaming read.
 *
 * This is the most safety-critical function in the codebase. It handles
 * irreplaceable personal data. Every step has an explicit guardrail.
 *
 * Order of operations:
 *   1. Path containment checks (dest and temp must be within the mount)
 *   2. Dest existence check (never overwrite)
 *   3. Temp existence check (UUID collision guard)
 *   4. Stream source → temp file + BLAKE3 hasher
 *   5. Atomic rename temp → final
 *
 * On any failure, the temp file is left in place (not cleaned up).
 * The caller tracks it via copy_items.temp_filename for later cleanup.
 *
 * Guardrails:
 *   - Path containment: both dest and temp paths must resolve within destMountPath
 *   - No overwrite: throws FileAlreadyExistsError if dest already exists
 *   - Exclusive create: temp file opened with 'wx' (O_CREAT | O_EXCL)
 *   - Atomic rename: same directory, same filesystem — guaranteed atomic on POSIX
 */
export async function copyFileAtomic(opts: {
  sourcePath: string;
  destMountPath: string;
  destRelativePath: string;
  tempSuffix: string;
  onChunkWritten?: (bytesWritten: number) => void;
}): Promise<{ fullHash: string; bytesWritten: number }> {
  const { sourcePath, destMountPath, destRelativePath, tempSuffix, onChunkWritten } = opts;

  const destAbsPath = path.join(destMountPath, destRelativePath);
  const tempPath = destAbsPath + `.backup-tmp-${tempSuffix}`;
  const resolvedMount = path.resolve(destMountPath);

  // 1. Path containment: dest and temp must both be inside the disk mount
  if (!path.resolve(destAbsPath).startsWith(resolvedMount)) {
    throw new Error(
      `copyFileAtomic: dest path "${destRelativePath}" escapes disk mount "${destMountPath}"`
    );
  }
  if (!path.resolve(tempPath).startsWith(resolvedMount)) {
    throw new Error(
      `copyFileAtomic: temp path escapes disk mount "${destMountPath}"`
    );
  }

  // 2. Dest existence guard: NEVER overwrite
  if (await Bun.file(destAbsPath).exists()) {
    throw new FileAlreadyExistsError(destAbsPath);
  }

  // 3. Temp existence guard: UUID suffix makes collision near-impossible, but defend anyway
  if (await Bun.file(tempPath).exists()) {
    throw new Error(
      `copyFileAtomic: temp file already exists at ${tempPath} — UUID collision or stale temp`
    );
  }

  // 4. Stream source → temp file + BLAKE3 hasher
  const hasher = createStreamingHasher();
  let bytesWritten = 0;

  // Open temp file with exclusive create — kernel-level exactly-once semantics
  let fh;
  try {
    fh = await open(tempPath, "wx");
  } catch (err: any) {
    if (err.code === "EEXIST") {
      throw new Error(`copyFileAtomic: temp file race — ${tempPath} appeared between check and open`);
    }
    throw err;
  }

  try {
    const stream = readFileStream(sourcePath);
    const reader = stream.getReader();
    let bytesSinceYield = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      hasher.update(value);
      await fh.write(value);
      bytesWritten += value.byteLength;
      bytesSinceYield += value.byteLength;
      onChunkWritten?.(value.byteLength);

      // Yield to the event loop periodically so the API stays responsive
      // during large file copies (a 26GB file would otherwise starve it).
      if (bytesSinceYield >= YIELD_EVERY_BYTES) {
        bytesSinceYield = 0;
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  } finally {
    await fh.close();
  }

  const fullHash = finaliseHash(hasher);

  // 5. Atomic rename: temp → final (same directory = same filesystem, atomic on POSIX)
  await rename(tempPath, destAbsPath);

  return { fullHash, bytesWritten };
}
