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
import { mkdir, open, rename, rmdir, unlink } from "fs/promises";
import path from "path";
import { fileExists, readFileStream } from "./disk-reads";
import { createStreamingHasher, finaliseHash } from "../jobs/scan/hasher";
import { freshnessMismatchReason, type FileFreshness } from "../lib/freshness";
import { isExcludedName } from "../lib/excluded-names";

/** Yield to the event loop every 64 MB during streaming copies. */
const YIELD_EVERY_BYTES = 64 * 1024 * 1024;

const DISK_ID_FILENAME = ".waypoint-disk-id";

/**
 * Returns true iff `absolutePath` resolves to `mountPath` itself or to a path
 * strictly underneath it. Uses a separator-aware comparison so that a sibling
 * mount whose name shares a prefix with `mountPath` (e.g. `/Volumes/Backup`
 * vs `/Volumes/BackupOld`) cannot be matched by a bare string prefix.
 *
 * Both inputs are resolved first so `..` segments are collapsed before
 * comparison.
 */
function isWithinMount(absolutePath: string, mountPath: string): boolean {
  const target = path.resolve(absolutePath);
  const root = path.resolve(mountPath);
  return target === root || target.startsWith(root + path.sep);
}

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
  const withinRoot = allowedRoots.some((root) => isWithinMount(resolved, root));
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
  if (!isWithinMount(absolutePath, destMountPath)) {
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

  // 1. Path containment: dest and temp must both be inside the disk mount.
  // isWithinMount is separator-aware so a sibling mount that shares a name
  // prefix (e.g. /Volumes/Backup vs /Volumes/BackupOld) cannot be matched.
  if (!isWithinMount(destAbsPath, destMountPath)) {
    throw new Error(
      `copyFileAtomic: dest path "${destRelativePath}" escapes disk mount "${destMountPath}"`
    );
  }
  if (!isWithinMount(tempPath, destMountPath)) {
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

  // 5. Atomic rename: temp → final (same directory = same filesystem, atomic on POSIX).
  //
  // Known TOCTOU window: POSIX rename(2) silently replaces the destination if
  // one appeared between the fileExists() check above and this call. Waypoint
  // is the sole writer on its backup disks during a copy job (write-lock
  // enforced by the lock manager) and external Finder/Spotlight writes don't
  // land on canonical backup paths, so the window is closed in practice.
  // Flagged previously by /review — accepted as-is for v1.
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
 *   2. Distinctness: the two paths must not resolve to the same file
 *   3. Existence: both the file to delete and the file to keep must exist
 *   4. Persisted identity: both files must carry the same selected-scan full hash
 *   5. Freshness: each file's current (size, mtime, sampled_hash) must match
 *      what the selected scan recorded. See `lib/freshness.ts` for the rule;
 *      the three signals together cover truncation, mtime drift, and sampled
 *      content change including the unsampled-bytes mtime cross-check.
 *
 * The caller computes the actual freshness off disk immediately before calling
 * this gateway; this function re-validates the proof bundle before unlinking
 * so the only write-capable function still owns the final deletion decision.
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
  deleteExpected: FileFreshness;
  keepExpected: FileFreshness;
  deleteActual: FileFreshness;
  keepActual: FileFreshness;
}): Promise<{ fullHash: string }> {
  const {
    deletePath,
    keepPath,
    diskMountPath,
    expectedFullHash,
    deleteFullHash,
    keepFullHash,
    deleteExpected,
    keepExpected,
    deleteActual,
    keepActual,
  } = opts;
  // 1. Path containment: both files must be on the expected disk.
  // isWithinMount enforces a path-separator boundary so a sibling mount that
  // shares a name prefix with diskMountPath cannot satisfy this check.
  if (!isWithinMount(deletePath, diskMountPath)) {
    throw new Error(
      `deleteDuplicateFile: delete path "${deletePath}" escapes disk mount "${diskMountPath}"`
    );
  }
  if (!isWithinMount(keepPath, diskMountPath)) {
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

  // 5. Both files must still match what the selected scan recorded right now
  // — size, mtime, and sampled hash all agree. See `lib/freshness.ts` for the
  // composition: each signal catches a different kind of drift.
  const deleteReason = freshnessMismatchReason(deleteExpected, deleteActual);
  if (deleteReason) {
    throw new Error(`deleteDuplicateFile: freshness drift on file to delete (${deleteReason}). Refusing to delete.`);
  }
  const keepReason = freshnessMismatchReason(keepExpected, keepActual);
  if (keepReason) {
    throw new Error(`deleteDuplicateFile: freshness drift on file to keep (${keepReason}). Refusing to delete.`);
  }

  // All guardrails passed — delete the file
  await unlink(deletePath);

  return { fullHash: expectedFullHash };
}

// ---------------------------------------------------------------------------
// Excluded "noise" file deletion (for directory duplicate cleanup)
// ---------------------------------------------------------------------------

/**
 * DELETE: Removes a single OS/Waypoint noise file (e.g. `.DS_Store`, `._*`,
 * `.waypoint-disk-id`) that the scanner intentionally never indexed.
 *
 * Why this exists:
 *   The directory-duplicate cleanup flow needs to leave delete folders fully
 *   empty so they can be rmdir'd. macOS sprinkles `.DS_Store` into every
 *   folder Finder ever touched, and resource-fork sidecars (`._*`) appear
 *   alongside files copied from old HFS+ media. These are not in the scan
 *   record (scanner filters them via `isExcludedName`), so the per-file
 *   delete gateway with its hash proof bundle cannot speak to them.
 *
 * Safety story (no hash proof needed, name-based allowlist instead):
 *   1. Path containment: filePath must resolve within diskMountPath. The
 *      same separator-aware check the other gateways use.
 *   2. Name allowlist: basename(filePath) must satisfy `isExcludedName`.
 *      This is the entire identity proof — only files matching that hard
 *      allowlist may be deleted by this gateway, ever.
 *   3. Existence: file must exist on disk right now.
 *   4. Kernel-enforced kind safety: `unlink` on a directory throws EISDIR,
 *      and on a symlink it removes the symlink (not the target). So the
 *      worst case for any unexpected kind is a clean error or a no-op.
 *
 * Like `deleteDuplicateFile`, this is intentionally not batched: each call
 * deletes exactly one file so a mid-loop failure leaves the rest intact.
 */
export async function deleteExcludedNoiseFile(opts: {
  filePath: string;
  diskMountPath: string;
}): Promise<void> {
  const { filePath, diskMountPath } = opts;

  if (!isWithinMount(filePath, diskMountPath)) {
    throw new Error(
      `deleteExcludedNoiseFile: path "${filePath}" escapes disk mount "${diskMountPath}"`
    );
  }

  const basename = path.basename(filePath);
  if (!isExcludedName(basename)) {
    throw new Error(
      `deleteExcludedNoiseFile: refusing to delete "${basename}" — name is not on the noise-file allowlist`
    );
  }

  if (!(await fileExists(filePath))) {
    throw new Error(`deleteExcludedNoiseFile: file does not exist: "${filePath}"`);
  }

  await unlink(filePath);
}

// ---------------------------------------------------------------------------
// Empty directory removal (for directory duplicate cleanup)
// ---------------------------------------------------------------------------

/**
 * DELETE: Removes a directory that must already be empty.
 *
 * Used by the directory-duplicate cleanup job after every descendant file
 * has been unlinked. POSIX rmdir(2) returns ENOTEMPTY for non-empty
 * directories, so the kernel itself enforces the "must be empty" invariant
 * — we cannot accidentally rm -rf anything from this gateway.
 *
 * Guardrails:
 *   1. Path containment: directoryPath must resolve inside diskMountPath.
 *   2. Distinctness: the path must not equal the disk mount root itself —
 *      removing the mount point would orphan all scan data and is never
 *      a legitimate cleanup step.
 *   3. Kernel-enforced: rmdir refuses non-empty directories with ENOTEMPTY.
 */
export async function removeEmptyDirectoryInsideMount(opts: {
  directoryPath: string;
  diskMountPath: string;
}): Promise<void> {
  const { directoryPath, diskMountPath } = opts;

  if (!isWithinMount(directoryPath, diskMountPath)) {
    throw new Error(
      `removeEmptyDirectoryInsideMount: path "${directoryPath}" escapes disk mount "${diskMountPath}"`
    );
  }

  if (path.resolve(directoryPath) === path.resolve(diskMountPath)) {
    throw new Error(
      `removeEmptyDirectoryInsideMount: refusing to remove disk mount root "${diskMountPath}"`
    );
  }

  await rmdir(directoryPath);
}

// ---------------------------------------------------------------------------
// Encoding scratch cleanup
// ---------------------------------------------------------------------------

/**
 * DELETE: Removes a single encoding-scratch artifact (an ffmpeg-encoded
 * variant output or an extracted JPEG frame) from inside the configured
 * scratch root.
 *
 * Guardrails:
 *   1. The path must resolve under `scratchRoot` — never outside it. Any
 *      attempt to escape via `..` is collapsed by path.resolve() before the
 *      comparison and therefore caught.
 *   2. The path must NOT equal the scratch root itself — we refuse to
 *      delete the root via this helper (use `removeEmptyDirectoryInsideMount`
 *      for that, which only succeeds when the directory is already empty).
 *   3. The basename must match the encoding-artifact pattern:
 *      `variant-NNN.<ext>` for variant outputs or `frame-NNN.jpg` for
 *      extracted frames. Anything else (including dotfiles like macOS
 *      `._variant-1.mp4` resource forks) is refused.
 *   4. The file must currently exist; missing-file is an error so the caller
 *      can distinguish "already cleaned" from "unexpected state".
 *
 * This helper deliberately only handles files. Directory removal goes
 * through `removeEmptyDirectoryInsideMount`, which uses rmdir(2) so the
 * kernel itself rejects non-empty inputs.
 */
const ENCODING_ARTIFACT_PATTERN =
  /^(variant-\d+\.[a-z0-9]+|frame-\d+\.jpg|frame-\d+\.jpeg)$/i;

export async function deleteEncodingScratchFile(opts: {
  filePath: string;
  scratchRoot: string;
}): Promise<void> {
  const { filePath, scratchRoot } = opts;

  if (!isWithinMount(filePath, scratchRoot)) {
    throw new Error(
      `deleteEncodingScratchFile: path "${filePath}" escapes scratch root "${scratchRoot}"`
    );
  }
  if (path.resolve(filePath) === path.resolve(scratchRoot)) {
    throw new Error(
      `deleteEncodingScratchFile: refusing to delete scratch root itself`
    );
  }

  const basename = path.basename(filePath);
  if (!ENCODING_ARTIFACT_PATTERN.test(basename)) {
    throw new Error(
      `deleteEncodingScratchFile: refusing to delete "${basename}" — not an encoding artifact name`
    );
  }

  if (!(await fileExists(filePath))) {
    throw new Error(`deleteEncodingScratchFile: file does not exist: "${filePath}"`);
  }

  await unlink(filePath);
}

// ---------------------------------------------------------------------------
// ffmpeg subprocess gateways
// ---------------------------------------------------------------------------

/**
 * WRITE: Spawns ffmpeg to encode `sourcePath` to `outputPath`.
 *
 * Guardrails:
 *   - `sourcePath` must resolve under `sourceMountPath` (typically a
 *     registered disk mount).
 *   - `outputPath` must resolve under `outputRootPath` (the scratch root
 *     declared on the parent encoding sample set).
 *   - `outputPath` must not already exist. We invoke ffmpeg with `-n` as a
 *     defence-in-depth so even a race-loss returns a non-zero exit code
 *     rather than overwriting.
 *   - The output's parent directory is created with `mkdir -p`.
 *
 * Returns the exit code, captured stderr (for diagnostics), the output file
 * size (bytes), and wall-clock seconds. Callers persist these to the
 * `encoding_variants` row.
 */
export async function runFfmpegEncode(opts: {
  sourcePath: string;
  sourceMountPath: string;
  outputPath: string;
  outputRootPath: string;
  clipStartSeconds: number | null;
  clipDurationSeconds: number | null;
  /** Encoder-side flags placed AFTER `-i source`, e.g. ['-c:v','libx265','-preset','slow','-crf','26']. */
  videoArgs: string[];
  /** Extra container/audio flags, e.g. ['-c:a','copy','-tag:v','hvc1']. */
  containerArgs: string[];
  signal?: AbortSignal;
}): Promise<{ exitCode: number; stderr: string; outputBytes: number; elapsedSeconds: number }> {
  if (!isWithinMount(opts.sourcePath, opts.sourceMountPath)) {
    throw new Error(
      `runFfmpegEncode: source "${opts.sourcePath}" escapes mount "${opts.sourceMountPath}"`
    );
  }
  if (!isWithinMount(opts.outputPath, opts.outputRootPath)) {
    throw new Error(
      `runFfmpegEncode: output "${opts.outputPath}" escapes scratch root "${opts.outputRootPath}"`
    );
  }
  if (await fileExists(opts.outputPath)) {
    throw new FileAlreadyExistsError(opts.outputPath);
  }

  await mkdir(path.dirname(opts.outputPath), { recursive: true });

  const args: string[] = ["-hide_banner", "-nostdin", "-n"];
  if (opts.clipStartSeconds != null) {
    args.push("-ss", String(opts.clipStartSeconds));
  }
  args.push("-i", opts.sourcePath);
  if (opts.clipDurationSeconds != null) {
    args.push("-t", String(opts.clipDurationSeconds));
  }
  args.push(...opts.videoArgs);
  args.push(...opts.containerArgs);
  args.push(opts.outputPath);

  const startedAt = Date.now();
  const proc = Bun.spawn(["ffmpeg", ...args], {
    stderr: "pipe",
    stdout: "ignore",
    signal: opts.signal,
  });
  const stderrBytes = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  let outputBytes = 0;
  if (exitCode === 0) {
    try {
      const fh = await open(opts.outputPath, "r");
      const stat = await fh.stat();
      outputBytes = stat.size;
      await fh.close();
    } catch {
      // fall through with size=0
    }
  }

  return { exitCode, stderr: stderrBytes, outputBytes, elapsedSeconds };
}

/**
 * WRITE: Extracts a single frame from `sourcePath` at `atSeconds` as a JPEG
 * at `outputPath`.
 *
 * Same guardrails as `runFfmpegEncode`. Used for the comparison-tool
 * blind-test frames.
 */
export async function runFfmpegFrameExtract(opts: {
  sourcePath: string;
  sourceMountPath: string;
  outputPath: string;
  outputRootPath: string;
  atSeconds: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; stderr: string }> {
  if (!isWithinMount(opts.sourcePath, opts.sourceMountPath)) {
    throw new Error(
      `runFfmpegFrameExtract: source "${opts.sourcePath}" escapes mount "${opts.sourceMountPath}"`
    );
  }
  if (!isWithinMount(opts.outputPath, opts.outputRootPath)) {
    throw new Error(
      `runFfmpegFrameExtract: output "${opts.outputPath}" escapes scratch root "${opts.outputRootPath}"`
    );
  }
  if (await fileExists(opts.outputPath)) {
    throw new FileAlreadyExistsError(opts.outputPath);
  }
  await mkdir(path.dirname(opts.outputPath), { recursive: true });

  // -ss before -i for fast seek; -frames:v 1 to grab a single frame; -q:v 2
  // gives a high-quality JPEG without going lossless (which would balloon
  // each frame to ~megabytes for no perceptible gain).
  const args = [
    "-hide_banner",
    "-nostdin",
    "-n",
    "-ss",
    String(opts.atSeconds),
    "-i",
    opts.sourcePath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    opts.outputPath,
  ];
  const proc = Bun.spawn(["ffmpeg", ...args], {
    stderr: "pipe",
    stdout: "ignore",
    signal: opts.signal,
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}
