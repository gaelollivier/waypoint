/**
 * Shared "is the file on disk still what the scan saw?" check.
 *
 * Used wherever a destructive or otherwise-irreversible operation needs to
 * prove the file hasn't drifted since the scan recorded its state. Combines
 * three orthogonal signals:
 *
 *   1. size       — stat() byte count
 *   2. mtime      — stat() modification time
 *   3. sampled    — BLAKE3 over the header / sampled interior / footer
 *
 * Each signal catches a different kind of drift:
 *   - size catches truncation / append.
 *   - mtime catches any write the kernel observed, even if sampled bytes
 *     happen to be unchanged (e.g. an edit landing only in the unsampled
 *     interior of a large file — the sampled-hash blind spot).
 *   - sampled catches content changes inside the sampled regions even when
 *     mtime was rewound (`touch -t`).
 *
 * All three must match for the file to be considered fresh.
 */

import { statFile } from "../fs/disk-reads";
import { computeSampledHash } from "../jobs/scan/hasher";

export interface FileFreshness {
  size: number;
  /** ISO-8601 timestamp; same format as `files.mtime` in the DB. */
  mtime: string;
  sampledHash: string;
}

/** Reads the current freshness signals off disk. */
export async function computeFileFreshness(filePath: string): Promise<FileFreshness> {
  const stat = await statFile(filePath);
  const sampledHash = await computeSampledHash(filePath, stat.size);
  return {
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    sampledHash,
  };
}

/**
 * Returns null when expected and actual agree on all three signals; otherwise
 * returns a short human-readable explanation of the first signal that drifted.
 *
 * Order matters for the message: size, then mtime, then sampled. Size and
 * mtime come from one stat() call and are cheaper to disagree on, so they
 * surface first in the typical drift case.
 */
export function freshnessMismatchReason(
  expected: FileFreshness,
  actual: FileFreshness
): string | null {
  if (expected.size !== actual.size) {
    return `size drift: scan recorded ${expected.size}, disk reports ${actual.size}`;
  }
  if (expected.mtime !== actual.mtime) {
    return `mtime drift: scan recorded ${expected.mtime}, disk reports ${actual.mtime}`;
  }
  if (expected.sampledHash !== actual.sampledHash) {
    return `sampled-hash drift: scan recorded ${expected.sampledHash}, disk reports ${actual.sampledHash}`;
  }
  return null;
}
