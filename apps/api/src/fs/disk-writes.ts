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
import { mkdir, open, rename, unlink } from "fs/promises";
import path from "path";
import { fileExists, readFileStream } from "./disk-reads";
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
// Host file browser integration (side-effect: launches Finder)
// ---------------------------------------------------------------------------

/**
 * Opens a path in Finder using macOS `open`.
 *
 * Guardrails:
 *   - The resolved path must be within one of the provided allowedRoots.
 *     This is defense-in-depth — callers also validate, but this function
 *     refuses to open arbitrary paths even if a caller forgets.
 */
export function openPathInFinder(absolutePath: string, allowedRoots: string[]): void {
  const resolved = path.resolve(absolutePath);
  const withinRoot = allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + "/");
  });
  if (!withinRoot) {
    throw new Error(
      `openPathInFinder: path "${absolutePath}" is not within any allowed root`
    );
  }

  const proc = Bun.spawnSync(["open", resolved], {
    stderr: "pipe",
    stdout: "ignore",
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(stderr || `open failed with exit code ${proc.exitCode}`);
  }
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

  const stream = readFileStream(sourcePath);
  const reader = stream.getReader();
  const chunks = async function* (): AsyncIterable<Uint8Array> {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  };

  const result = await writeAtomicFileFromChunks({
    destMountPath,
    destRelativePath,
    tempSuffix,
    tempMarker: ".backup-tmp-",
    chunks: chunks(),
    computeHash: true,
    onChunkWritten,
  });

  if (!result.fullHash) {
    throw new Error("copyFileAtomic: internal error — missing full hash");
  }

  return { fullHash: result.fullHash, bytesWritten: result.bytesWritten };
}

/**
 * WRITE: Writes generated data to a new dotfile on a disk using the same
 * temp→rename streaming path as the copy job.
 *
 * Guardrails:
 *   - The final filename is always `.waypoint-test-copy-<uuid>`.
 *   - The final and temp paths must resolve inside the disk mount.
 *   - Existing final/temp files are never overwritten.
 */
export async function writeGeneratedTestFileAtomic(opts: {
  destMountPath: string;
  fileUuid: string;
  totalBytes: number;
  mode: "null" | "random";
  tempSuffix: string;
  onChunkWritten?: (bytesWritten: number) => void | Promise<void>;
}): Promise<{ relativePath: string; bytesWritten: number }> {
  const { destMountPath, fileUuid, totalBytes, mode, tempSuffix, onChunkWritten } = opts;
  const relativePath = `.waypoint-test-copy-${fileUuid}`;

  if (!/^[0-9a-f-]{36}$/i.test(fileUuid)) {
    throw new Error(`writeGeneratedTestFileAtomic: invalid UUID ${fileUuid}`);
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error("writeGeneratedTestFileAtomic: totalBytes must be a positive safe integer");
  }

  const result = await writeAtomicFileFromChunks({
    destMountPath,
    destRelativePath: relativePath,
    tempSuffix,
    tempMarker: ".write-speed-tmp-",
    chunks: generateTestChunks(totalBytes, mode),
    computeHash: false,
    onChunkWritten,
  });

  return { relativePath, bytesWritten: result.bytesWritten };
}

async function writeAtomicFileFromChunks(opts: {
  destMountPath: string;
  destRelativePath: string;
  tempSuffix: string;
  tempMarker: string;
  chunks: AsyncIterable<Uint8Array>;
  computeHash: boolean;
  onChunkWritten?: (bytesWritten: number) => void | Promise<void>;
}): Promise<{ fullHash: string | null; bytesWritten: number }> {
  const {
    destMountPath,
    destRelativePath,
    tempSuffix,
    tempMarker,
    chunks,
    computeHash,
    onChunkWritten,
  } = opts;

  const destAbsPath = path.join(destMountPath, destRelativePath);
  const tempPath = destAbsPath + `${tempMarker}${tempSuffix}`;
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
  if (await fileExists(destAbsPath)) {
    throw new FileAlreadyExistsError(destAbsPath);
  }

  // 3. Temp existence guard: UUID suffix makes collision near-impossible, but defend anyway
  if (await fileExists(tempPath)) {
    throw new Error(
      `copyFileAtomic: temp file already exists at ${tempPath} — UUID collision or stale temp`
    );
  }

  // 4. Stream source → temp file + BLAKE3 hasher
  const hasher = computeHash ? createStreamingHasher() : null;
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
    let bytesSinceYield = 0;

    for await (const value of chunks) {
      hasher?.update(value);
      await fh.write(value);
      bytesWritten += value.byteLength;
      bytesSinceYield += value.byteLength;
      await onChunkWritten?.(value.byteLength);

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

  const fullHash = hasher ? finaliseHash(hasher) : null;

  // 5. Atomic rename: temp → final (same directory = same filesystem, atomic on POSIX)
  await rename(tempPath, destAbsPath);

  return { fullHash, bytesWritten };
}

async function* generateTestChunks(
  totalBytes: number,
  mode: "null" | "random"
): AsyncIterable<Uint8Array> {
  const chunkSize = 1024 * 1024;
  let remaining = totalBytes;

  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    const chunk = new Uint8Array(size);
    if (mode === "random") fillRandom(chunk);
    remaining -= size;
    yield chunk;
  }
}

function fillRandom(chunk: Uint8Array): void {
  const max = 65_536;
  for (let offset = 0; offset < chunk.byteLength; offset += max) {
    crypto.getRandomValues(chunk.subarray(offset, Math.min(offset + max, chunk.byteLength)));
  }
}

// ---------------------------------------------------------------------------
// Duplicate file deletion (for duplicate cleanup)
// ---------------------------------------------------------------------------

/**
 * DELETE: Removes a file after duplicate-cleanup evidence has been verified.
 *
 * This is the most dangerous function in the codebase. It permanently
 * destroys data. Every precondition is checked before the unlink.
 *
 * Guardrails:
 *   1. Path containment: deletePath and keepPath must resolve within diskMountPath
 *   2. Existence: both the file to delete and the file to keep must exist
 *   3. Persisted identity: both files must carry the same selected-scan full hash
 *   4. Freshness: both files' freshly recomputed sampled hashes must still match
 *      the sampled hashes recorded by that same selected scan
 *   5. Distinctness: the two paths must not resolve to the same file
 *
 * The route recomputes sampled hashes immediately before calling this gateway;
 * this function re-validates the resulting proof bundle before unlinking so the
 * only write-capable function still owns the final deletion decision.
 *
 * This function is intentionally NOT batched. Each file is deleted one at a
 * time so that any mid-sequence failure leaves the remaining files intact.
 */
export async function deleteDuplicateFile(opts: {
  deletePath: string;
  keepPath: string;
  diskMountPath: string;
  expectedFullHash: string;
  deleteFullHash: string;
  keepFullHash: string;
  deleteExpectedSampledHash: string;
  keepExpectedSampledHash: string;
  deleteActualSampledHash: string;
  keepActualSampledHash: string;
}): Promise<{ fullHash: string }> {
  const {
    deletePath,
    keepPath,
    diskMountPath,
    expectedFullHash,
    deleteFullHash,
    keepFullHash,
    deleteExpectedSampledHash,
    keepExpectedSampledHash,
    deleteActualSampledHash,
    keepActualSampledHash,
  } = opts;
  const resolvedMount = path.resolve(diskMountPath);

  // 1. Path containment: both files must be on the expected disk
  if (!path.resolve(deletePath).startsWith(resolvedMount)) {
    throw new Error(
      `deleteDuplicateFile: delete path "${deletePath}" escapes disk mount "${diskMountPath}"`
    );
  }
  if (!path.resolve(keepPath).startsWith(resolvedMount)) {
    throw new Error(
      `deleteDuplicateFile: keep path "${keepPath}" escapes disk mount "${diskMountPath}"`
    );
  }

  // 2. The two paths must not resolve to the same file
  if (path.resolve(deletePath) === path.resolve(keepPath)) {
    throw new Error(
      `deleteDuplicateFile: delete path and keep path resolve to the same file: "${deletePath}"`
    );
  }

  // 3. Both files must exist on disk right now
  if (!(await fileExists(deletePath))) {
    throw new Error(
      `deleteDuplicateFile: file to delete does not exist: "${deletePath}"`
    );
  }
  if (!(await fileExists(keepPath))) {
    throw new Error(
      `deleteDuplicateFile: file to keep does not exist: "${keepPath}" — refusing to delete the only copy`
    );
  }

  // 4. Both files must have been proven identical by the selected scan.
  if (deleteFullHash !== expectedFullHash || keepFullHash !== expectedFullHash) {
    throw new Error(
      "deleteDuplicateFile: selected-scan full-hash proof does not match for both files. Refusing to delete."
    );
  }

  // 5. Both files must still match that selected scan right now.
  if (deleteActualSampledHash !== deleteExpectedSampledHash) {
    throw new Error(
      "deleteDuplicateFile: sampled hash mismatch for file to delete. Refusing to delete."
    );
  }
  if (keepActualSampledHash !== keepExpectedSampledHash) {
    throw new Error(
      "deleteDuplicateFile: sampled hash mismatch for file to keep. Refusing to delete."
    );
  }

  // All guardrails passed — delete the file
  await unlink(deletePath);

  return { fullHash: expectedFullHash };
}
