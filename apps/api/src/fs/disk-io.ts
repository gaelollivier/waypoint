/**
 * disk-io.ts — ALL READ-ONLY FILESYSTEM AND DISK OPERATIONS.
 *
 * Every read, stat, directory listing, and disk-info spawn in the API must go
 * through this module. No other source file (outside of __tests__) may import
 * from "fs", "fs/promises", or use Bun.file directly for reads.
 *
 * WRITE OPERATIONS live in disk-writes.ts. Separating reads from writes makes
 * it trivial to audit what can modify data on disk — you only need to read
 * disk-writes.ts.
 *
 * Convention:
 *   READ operations  — cannot cause data loss, safe by default.
 *   PROCESS ops      — spawn external tools (df, diskutil) for metadata only.
 */

import { readdirSync, readFileSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import type { Dirent } from "fs";

export type { Dirent };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileStat {
  mtime: Date;
  /** File size in bytes. */
  size: number;
  /**
   * macOS BSD flags (e.g. SF_DATALESS = 0x40000000 for iCloud stub files).
   * Undefined on non-macOS or when the flag field isn't available.
   */
  flags?: number;
}

// ---------------------------------------------------------------------------
// Volumes / disk metadata (process-based, read-only)
// ---------------------------------------------------------------------------

/**
 * Lists the names of volumes mounted under /Volumes on macOS.
 * Skips hidden entries (names starting with '.').
 * Returns [] on any error (e.g. /Volumes not present).
 */
export async function listVolumes(): Promise<string[]> {
  try {
    const entries = await readdir("/Volumes");
    return entries.filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * Returns the capacity and free bytes for the volume at mountPath.
 * Uses `df -Pk <mountPath>` — the POSIX-standard, 1K-block output.
 * Returns nulls if the path isn't mounted or df fails.
 */
export function getDiskStats(
  mountPath: string
): { capacityBytes: number | null; freeBytes: number | null } {
  const proc = Bun.spawnSync(["df", "-Pk", mountPath], { stderr: "ignore" });
  if (proc.exitCode !== 0) return { capacityBytes: null, freeBytes: null };
  const lines = proc.stdout.toString().trim().split("\n");
  if (lines.length < 2) return { capacityBytes: null, freeBytes: null };
  const parts = lines[1].trim().split(/\s+/);
  if (parts.length < 4) return { capacityBytes: null, freeBytes: null };
  return {
    capacityBytes: Number(parts[1]) * 1024,
    freeBytes: Number(parts[3]) * 1024,
  };
}

/**
 * Detects whether a volume is SSD or HDD via `diskutil info <mountPath>`.
 * Falls back to "hdd" on any failure — more conservative for I/O concurrency
 * tuning (HDDs tolerate less parallelism than SSDs).
 */
export async function detectDiskKind(
  mountPath: string
): Promise<"ssd" | "hdd"> {
  try {
    const proc = Bun.spawnSync(["diskutil", "info", mountPath], {
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return "hdd";
    const out = proc.stdout.toString();
    const match = out.match(/Solid State:\s*(Yes|No)/i);
    if (match) return match[1].toLowerCase() === "yes" ? "ssd" : "hdd";
    return "hdd";
  } catch {
    return "hdd";
  }
}

// ---------------------------------------------------------------------------
// Existence checks
// ---------------------------------------------------------------------------

/**
 * Returns true if the file or directory at filePath exists on disk.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  return Bun.file(filePath).exists();
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

/**
 * Reads a directory and returns its entries with type information.
 * Throws on permission errors — the caller is responsible for handling EACCES/EPERM.
 */
export async function readDirectory(dirPath: string): Promise<Dirent[]> {
  return readdir(dirPath, { withFileTypes: true });
}

/**
 * Lists file/directory names in a directory. Synchronous.
 * Use only at startup time (e.g. loading migration files) — not in request paths.
 */
export function listDirSync(dirPath: string): string[] {
  return readdirSync(dirPath);
}

// ---------------------------------------------------------------------------
// File stat
// ---------------------------------------------------------------------------

/**
 * Stats a file and returns its mtime, size, and optional macOS BSD flags.
 */
export async function statFile(filePath: string): Promise<FileStat> {
  const stat = await Bun.file(filePath).stat();
  return {
    mtime: new Date(stat.mtime),
    size: stat.size,
    flags: (stat as any).flags,
  };
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

/**
 * Reads a file's entire content as text. Async.
 */
export async function readTextFile(filePath: string): Promise<string> {
  return Bun.file(filePath).text();
}

/**
 * Reads a file's entire content as text. Synchronous.
 * Use only at startup time (e.g. loading migration SQL) — not in request paths.
 */
export function readTextFileSync(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/**
 * Reads a byte slice of a file without loading the full file into memory.
 * start/end are byte offsets (end is exclusive, matching the Blob.slice API).
 * Used for sampled hashing of large files.
 */
export async function readFileSlice(
  filePath: string,
  start: number,
  end: number
): Promise<ArrayBuffer> {
  return Bun.file(filePath).slice(start, end).arrayBuffer();
}

/**
 * Reads a file's entire content as an ArrayBuffer.
 * Used for full hashing of small files (≤ 100 KB).
 */
export async function readFileAll(filePath: string): Promise<ArrayBuffer> {
  return Bun.file(filePath).arrayBuffer();
}
