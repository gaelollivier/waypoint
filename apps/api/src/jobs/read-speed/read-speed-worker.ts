/**
 * read-speed-worker.ts — Bun Worker that benchmarks disk read speed.
 *
 * Runs file reads + BLAKE3 hashing entirely off the main thread so the API
 * event loop stays responsive. The main thread sends a list of files; this
 * worker hashes each one (sampled + full) and reports results back.
 *
 * Protocol (postMessage):
 *   Main → Worker:  { type: "start", files: Array<{ path, sizeBytes }> }
 *   Main → Worker:  { type: "pause" } / { type: "resume" } / { type: "cancel" }
 *   Worker → Main:  { type: "file_done", result: FileResult }
 *   Worker → Main:  { type: "done" }
 *   Worker → Main:  { type: "error", message: string }
 */

import { _BLAKE3, blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// -- Sampled hash constants (must match hasher.ts) --------------------------

const FULL_HASH_THRESHOLD = 100 * 1024;
const HEADER_SIZE = 8 * 1024;
const SAMPLE_SIZE = 10 * 1024;
const FOOTER_SIZE = 8 * 1024;

// -- Types ------------------------------------------------------------------

interface FileTarget {
  path: string;
  sizeBytes: number;
}

interface FileResult {
  path: string;
  sizeBytes: number;
  sampledHashMs: number;
  sampledHashMBps: number;
  fullHashMs: number;
  fullHashMBps: number;
}

type InboundMessage =
  | { type: "start"; files: FileTarget[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" };

// -- State ------------------------------------------------------------------

let paused = false;
let cancelled = false;
let pauseResolve: (() => void) | null = null;

// -- Helpers ----------------------------------------------------------------

async function checkPauseOrCancel(): Promise<void> {
  if (cancelled) throw new Error("cancelled");
  if (!paused) return;
  await new Promise<void>((resolve) => {
    pauseResolve = resolve;
  });
  if (cancelled) throw new Error("cancelled");
}

function mbps(bytes: number, ms: number): number {
  return ms > 0 ? (bytes / (1024 * 1024)) / (ms / 1000) : 0;
}

// -- Hashing (replicated from hasher.ts to avoid main-thread module deps) ---

async function computeSampledHash(filePath: string, sizeBytes: number): Promise<void> {
  if (sizeBytes <= FULL_HASH_THRESHOLD) {
    const buf = await Bun.file(filePath).arrayBuffer();
    blake3(new Uint8Array(buf));
    return;
  }

  const hasher = new _BLAKE3();

  const sizeBuf = new Uint8Array(8);
  const view = new DataView(sizeBuf.buffer);
  view.setBigUint64(0, BigInt(sizeBytes), true);
  hasher.update(sizeBuf);

  const feed = async (start: number, end: number): Promise<void> => {
    const buf = await Bun.file(filePath).slice(start, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
  };

  await feed(0, HEADER_SIZE);
  for (let i = 1; i <= 4; i++) {
    const offset = Math.floor((sizeBytes / 5) * i) - Math.floor(SAMPLE_SIZE / 2);
    const start = Math.max(HEADER_SIZE, Math.min(offset, sizeBytes - FOOTER_SIZE - SAMPLE_SIZE));
    await feed(start, start + SAMPLE_SIZE);
  }
  await feed(Math.max(0, sizeBytes - FOOTER_SIZE), sizeBytes);

  hasher.digest();
}

async function computeFullHashStreaming(filePath: string): Promise<void> {
  const stream = Bun.file(filePath).stream();
  const hasher = new _BLAKE3();
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  hasher.digest();
}

// -- Main benchmark logic ---------------------------------------------------

async function run(files: FileTarget[]): Promise<void> {
  for (const file of files) {
    await checkPauseOrCancel();

    const sampledStart = performance.now();
    await computeSampledHash(file.path, file.sizeBytes);
    const sampledMs = performance.now() - sampledStart;

    const fullStart = performance.now();
    await computeFullHashStreaming(file.path);
    const fullMs = performance.now() - fullStart;

    const result: FileResult = {
      path: file.path,
      sizeBytes: file.sizeBytes,
      sampledHashMs: Math.round(sampledMs),
      sampledHashMBps: Math.round(mbps(file.sizeBytes, sampledMs) * 10) / 10,
      fullHashMs: Math.round(fullMs),
      fullHashMBps: Math.round(mbps(file.sizeBytes, fullMs) * 10) / 10,
    };

    postMessage({ type: "file_done", result });
  }

  postMessage({ type: "done" });
}

// -- Message handler --------------------------------------------------------

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "start":
      run(msg.files).catch((err) => {
        if (err.message !== "cancelled") {
          postMessage({ type: "error", message: err.message });
        }
      });
      break;

    case "pause":
      paused = true;
      break;

    case "resume":
      paused = false;
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
      break;

    case "cancel":
      cancelled = true;
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
      break;
  }
};
