import { _BLAKE3, blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSlice, readFileAll } from "../../fs/disk-io";

export const HASH_ALGO_VERSION = 1;

// Thresholds and sample sizes (matching decisions.md Spacedrive pattern)
const FULL_HASH_THRESHOLD = 100 * 1024; // 100 KB
const HEADER_SIZE = 8 * 1024;           // 8 KB
const SAMPLE_SIZE = 10 * 1024;          // 10 KB each (× 4 interior samples)
const FOOTER_SIZE = 8 * 1024;           // 8 KB

/**
 * Computes a sampled BLAKE3 hash for change-detection identity.
 *
 * Algorithm (from decisions.md):
 *   Files ≤ 100KB : full content hash
 *   Files > 100KB : BLAKE3( size_as_8_le_bytes || header[8KB] ||
 *                           sample₁[10KB] || sample₂[10KB] ||
 *                           sample₃[10KB] || sample₄[10KB] ||
 *                           footer[8KB] )
 *
 * The size prefix prevents collisions across files that differ only in size
 * but have identical sampled bytes.
 *
 * Returns a 64-char hex string.
 */
export async function computeSampledHash(filePath: string, sizeBytes: number): Promise<string> {
  if (sizeBytes <= FULL_HASH_THRESHOLD) {
    return computeFullHash(filePath);
  }

  const hasher = new _BLAKE3();

  // Size prefix: 8 bytes little-endian (BigInt for > 32-bit sizes)
  const sizeBuf = new Uint8Array(8);
  const view = new DataView(sizeBuf.buffer);
  view.setBigUint64(0, BigInt(sizeBytes), true);
  hasher.update(sizeBuf);

  // Read only the byte ranges we need — never load the whole file.
  const feed = async (start: number, end: number): Promise<void> => {
    const buf = await readFileSlice(filePath, start, end);
    hasher.update(new Uint8Array(buf));
  };

  // Header
  await feed(0, HEADER_SIZE);

  // 4 interior samples, evenly distributed
  for (let i = 1; i <= 4; i++) {
    const offset = Math.floor((sizeBytes / 5) * i) - Math.floor(SAMPLE_SIZE / 2);
    const start = Math.max(HEADER_SIZE, Math.min(offset, sizeBytes - FOOTER_SIZE - SAMPLE_SIZE));
    await feed(start, start + SAMPLE_SIZE);
  }

  // Footer
  await feed(Math.max(0, sizeBytes - FOOTER_SIZE), sizeBytes);

  return bytesToHex(hasher.digest());
}

/**
 * Computes a full BLAKE3 hash of a file's entire content.
 * Used for files ≤ 100KB, and during copy jobs for the full_hash column.
 * Returns a 64-char hex string.
 */
export async function computeFullHash(filePath: string): Promise<string> {
  const buf = await readFileAll(filePath);
  return bytesToHex(blake3(new Uint8Array(buf)));
}

/**
 * Returns a streaming BLAKE3 hasher for use during file copy (accumulate
 * as bytes are read, finalise with .digest() at the end).
 */
export function createStreamingHasher(): InstanceType<typeof _BLAKE3> {
  return new _BLAKE3();
}

export function finaliseHash(hasher: InstanceType<typeof _BLAKE3>): string {
  return bytesToHex(hasher.digest());
}
