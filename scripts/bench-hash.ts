/**
 * bench-hash.ts — Compare BLAKE3 hash pipelines against the raw-read ceiling.
 *
 * For each variant, streams the chosen file once and reports MB/s:
 *
 *   raw         Raw read, no hash                          (ceiling reference)
 *   noble       Bun stream + @noble/hashes BLAKE3          (current prod path)
 *   napi        Bun stream + @napi-rs/blake-hash BLAKE3    (native, recommended)
 *   wasm        Bun stream + hash-wasm BLAKE3              (WASM fallback)
 *   sha256      Bun stream + Bun.CryptoHasher SHA-256      (reference, would
 *                                                           require DB rehash)
 *
 * File selection mirrors the in-app read-speed-test: the N largest files
 * from the latest completed scan for the given disk.
 *
 * Cache behaviour: results below a file size of ~free RAM will likely be
 * served from the OS page cache after the first read. To measure cold-disk
 * speed, use a file larger than free RAM, or run `sudo purge` between runs.
 * This script prints a cache-fits warning when applicable.
 *
 * Usage:
 *   bun scripts/bench-hash.ts --disk-id <id> [--runs 3] [--count 1] [--max-gb 10]
 *   bun scripts/bench-hash.ts --file /path/to/file.dat [--runs 3]
 *
 * --max-gb caps the file size when picking from the scan. Default 10 GB
 * keeps the total benchmark time reasonable (5 variants × N runs × file size).
 *
 * READ-ONLY — opens the DB read-only and never writes any file.
 */

import { Database } from "bun:sqlite";
import { createReadStream } from "fs";
import path from "path";
import os from "os";

import { _BLAKE3 } from "@noble/hashes/blake3.js";
import { Blake3Hasher } from "@napi-rs/blake-hash";
import { createBLAKE3 } from "hash-wasm";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function argFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const diskIdArg = argFlag("--disk-id");
const fileArg = argFlag("--file");
const runs = Number(argFlag("--runs") ?? 3);
const count = Number(argFlag("--count") ?? 1);
const maxGb = Number(argFlag("--max-gb") ?? 10);
const maxBytes = maxGb * 1024 ** 3;

if (!diskIdArg && !fileArg) {
  console.error("Usage:");
  console.error("  bun scripts/bench-hash.ts --disk-id <id> [--runs 3] [--count 1]");
  console.error("  bun scripts/bench-hash.ts --file <path>  [--runs 3]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File selection — mirrors read-speed-job.findLargestFiles()
// ---------------------------------------------------------------------------

interface FileTarget {
  path: string;
  sizeBytes: number;
}

function pickFilesFromDb(diskId: number, n: number): FileTarget[] {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME not set");
  const dbPath = process.env.DB_PATH ?? path.join(home, ".waypoint", "waypoint.db");

  // readonly: true ensures this script cannot mutate the DB.
  const db = new Database(dbPath, { readonly: true });

  const latestScan = db
    .prepare(
      `SELECT id FROM jobs
       WHERE type = 'scan' AND target_disk_id = ? AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`
    )
    .get(diskId) as { id: number } | null;

  if (!latestScan) {
    db.close();
    throw new Error(`No completed scan found for disk_id=${diskId}`);
  }

  const rows = db
    .prepare(
      `SELECT path, size_bytes FROM files
       WHERE scan_id = ? AND size_bytes > 0 AND size_bytes <= ?
       ORDER BY size_bytes DESC
       LIMIT ?`
    )
    .all(latestScan.id, maxBytes, n) as Array<{
      path: string;
      size_bytes: number;
    }>;

  db.close();
  return rows.map((r) => ({ path: r.path, sizeBytes: r.size_bytes }));
}

// ---------------------------------------------------------------------------
// Variants — each consumes a Bun.file(...).stream() reader exactly once.
// ---------------------------------------------------------------------------

type Variant = {
  name: string;
  run: (filePath: string) => Promise<number>; // returns bytes read
};

async function readAllChunks(
  filePath: string,
  onChunk: (chunk: Uint8Array) => void
): Promise<number> {
  const reader = Bun.file(filePath).stream().getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    onChunk(value);
  }
  return total;
}

const variants: Variant[] = [
  {
    name: "raw",
    run: (p) => readAllChunks(p, () => {}),
  },
  {
    name: "noble",
    run: async (p) => {
      const h = new _BLAKE3();
      const bytes = await readAllChunks(p, (c) => h.update(c));
      h.digest();
      return bytes;
    },
  },
  {
    name: "napi",
    run: async (p) => {
      const h = new Blake3Hasher();
      const bytes = await readAllChunks(p, (c) => {
        // napi binding expects Buffer; Uint8Array works because Buffer
        // extends Uint8Array, but be explicit to avoid any copy surprises.
        h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
      });
      h.digest("hex");
      return bytes;
    },
  },
  {
    name: "wasm",
    run: async (p) => {
      const h = await createBLAKE3();
      const bytes = await readAllChunks(p, (c) => h.update(c));
      h.digest("hex");
      return bytes;
    },
  },
  {
    name: "sha256",
    run: async (p) => {
      const h = new Bun.CryptoHasher("sha256");
      const bytes = await readAllChunks(p, (c) => h.update(c));
      h.digest("hex");
      return bytes;
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function mbps(bytes: number, ms: number): number {
  return ms > 0 ? bytes / (1024 * 1024) / (ms / 1000) : 0;
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(1)} KB`;
}

async function benchFile(target: FileTarget): Promise<void> {
  console.log("");
  console.log("=".repeat(72));
  console.log(`File: ${target.path}`);
  console.log(`Size: ${fmtBytes(target.sizeBytes)}`);

  const freeRam = os.freemem();
  if (target.sizeBytes < freeRam) {
    console.log(
      `Note: file fits in free RAM (${fmtBytes(freeRam)} free) — ` +
        `second and later runs will likely hit the OS page cache.`
    );
  }
  console.log("=".repeat(72));

  // Interleave variants across runs so each variant sees roughly the
  // same cache state on a given run number.
  const results = new Map<string, number[]>();
  for (const v of variants) results.set(v.name, []);

  for (let r = 1; r <= runs; r++) {
    console.log(`\n-- run ${r}/${runs} --`);
    for (const v of variants) {
      const t0 = performance.now();
      const bytes = await v.run(target.path);
      const ms = performance.now() - t0;
      const speed = mbps(bytes, ms);
      results.get(v.name)!.push(speed);
      console.log(
        `  ${v.name.padEnd(8)}  ${speed.toFixed(1).padStart(7)} MB/s   (${ms.toFixed(0)} ms)`
      );
    }
  }

  console.log("\nSummary (MB/s):");
  console.log(
    `  ${"variant".padEnd(8)}  ${"best".padStart(7)}  ${"avg".padStart(7)}  ${"last".padStart(7)}`
  );
  for (const v of variants) {
    const arr = results.get(v.name)!;
    const best = Math.max(...arr);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const last = arr[arr.length - 1];
    console.log(
      `  ${v.name.padEnd(8)}  ${best.toFixed(1).padStart(7)}  ${avg.toFixed(1).padStart(7)}  ${last.toFixed(1).padStart(7)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let targets: FileTarget[];
if (fileArg) {
  const stat = await Bun.file(fileArg).stat();
  targets = [{ path: fileArg, sizeBytes: stat.size }];
} else {
  const diskId = Number(diskIdArg);
  if (!Number.isFinite(diskId)) {
    console.error(`--disk-id must be a number, got: ${diskIdArg}`);
    process.exit(1);
  }
  targets = pickFilesFromDb(diskId, count);
  if (targets.length === 0) {
    console.error(`No files found for disk_id=${diskId} in latest scan`);
    process.exit(1);
  }
}

console.log(`Runs per variant: ${runs}`);
console.log(`Variants:         ${variants.map((v) => v.name).join(", ")}`);
console.log(`Files:            ${targets.length}`);

for (const target of targets) {
  await benchFile(target);
}
