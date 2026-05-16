import { Blake3Hasher, blake3 } from "@napi-rs/blake-hash";
import { readFileSlice, readFileAll, readFileStream } from "../../fs/disk-reads";

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

  const hasher = new Blake3Hasher();

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

  return hasher.digest("hex");
}

/**
 * Computes a full BLAKE3 hash of a file's entire content.
 * Used for files ≤ 100KB, and during copy jobs for the full_hash column.
 *
 * WARNING: Loads the entire file into memory. Only safe for small files.
 * For large files, use computeFullHashStreaming() instead.
 *
 * Returns a 64-char hex string.
 */
export async function computeFullHash(filePath: string): Promise<string> {
  const buf = await readFileAll(filePath);
  return blake3(new Uint8Array(buf)).toString("hex");
}

/**
 * Computes a full BLAKE3 hash by streaming the file in chunks.
 * Safe for files of any size — memory usage is bounded by the chunk size
 * chosen by Bun's ReadableStream (typically 64 KB).
 *
 * Returns a 64-char hex string.
 */
export async function computeFullHashStreaming(filePath: string): Promise<string> {
  const stream = readFileStream(filePath);
  const hasher = createStreamingHasher();
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return finaliseHash(hasher);
}

/**
 * Returns a streaming BLAKE3 hasher for use during file copy (accumulate
 * as bytes are read, finalise with .digest() at the end).
 */
export function createStreamingHasher(): Blake3Hasher {
  return new Blake3Hasher();
}

export function finaliseHash(hasher: Blake3Hasher): string {
  return hasher.digest("hex");
}
