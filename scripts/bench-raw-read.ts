/**
 * bench-raw-read.ts — Measure theoretical max sequential read speed.
 *
 * Streams a file from disk and discards every chunk without any processing.
 * This gives the ceiling that any read+hash pipeline can approach but never
 * exceed.
 *
 * Usage:
 *   bun scripts/bench-raw-read.ts /path/to/large-file [runs]
 *
 * "runs" defaults to 3.  The first run warms the OS page cache; subsequent
 * runs show cached throughput.  To measure cold-cache speed, use a file
 * larger than RAM or purge the cache between runs (`sudo purge` on macOS).
 *
 * READ-ONLY — no data is written, created, or modified.
 */

const filePath = process.argv[2];
const runs = Number(process.argv[3] ?? 3);

if (!filePath) {
  console.error("Usage: bun scripts/bench-raw-read.ts <file-path> [runs]");
  process.exit(1);
}

function formatMbps(bytes: number, ms: number): string {
  const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
  return `${mbps.toFixed(1)} MB/s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function benchmarkRawRead(path: string): Promise<{ bytes: number; ms: number }> {
  const file = Bun.file(path);
  const stream = file.stream();
  const reader = stream.getReader();

  let totalBytes = 0;
  const t0 = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
  }

  const ms = performance.now() - t0;
  return { bytes: totalBytes, ms };
}

// -- Main -------------------------------------------------------------------

const file = Bun.file(filePath);
const exists = await file.exists();
if (!exists) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const stat = await file.stat();
console.log(`File: ${filePath}`);
console.log(`Size: ${formatBytes(stat.size)}`);
console.log(`Runs: ${runs}`);
console.log("─".repeat(60));

const results: number[] = [];

for (let i = 1; i <= runs; i++) {
  const { bytes, ms } = await benchmarkRawRead(filePath);
  const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
  results.push(mbps);
  console.log(`Run ${i}: ${formatMbps(bytes, ms)}  (${ms.toFixed(0)} ms)`);
}

console.log("─".repeat(60));

const best = Math.max(...results);
const avg = results.reduce((a, b) => a + b, 0) / results.length;
const last = results[results.length - 1];

console.log(`Best:    ${best.toFixed(1)} MB/s`);
console.log(`Average: ${avg.toFixed(1)} MB/s`);
console.log(`Last:    ${last.toFixed(1)} MB/s  (most likely cached)`);
