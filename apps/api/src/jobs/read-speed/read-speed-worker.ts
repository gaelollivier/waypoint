/**
 * read-speed-worker.ts — Bun Worker that benchmarks disk read speed.
 *
 * Runs file reads + BLAKE3 hashing entirely off the main thread so the API
 * event loop stays responsive. The main thread sends a list of files; this
 * worker reads each one fully through BLAKE3 and reports timing back.
 *
 * Protocol (postMessage):
 *   Main → Worker:  { type: "start", files: Array<{ path, sizeBytes }> }
 *   Main → Worker:  { type: "pause" } / { type: "resume" } / { type: "cancel" }
 *   Worker → Main:  { type: "file_done", result: FileResult }
 *   Worker → Main:  { type: "done" }
 *   Worker → Main:  { type: "error", message: string }
 */

import { _BLAKE3 } from "@noble/hashes/blake3.js";

// -- Types ------------------------------------------------------------------

interface FileTarget {
  path: string;
  sizeBytes: number;
}

interface FileResult {
  path: string;
  sizeBytes: number;
  hashMs: number;
  mbps: number;
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

function toMbps(bytes: number, ms: number): number {
  return ms > 0 ? (bytes / (1024 * 1024)) / (ms / 1000) : 0;
}

// -- Hashing ----------------------------------------------------------------

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

    const t0 = performance.now();
    await computeFullHashStreaming(file.path);
    const hashMs = performance.now() - t0;

    const result: FileResult = {
      path: file.path,
      sizeBytes: file.sizeBytes,
      hashMs: Math.round(hashMs),
      mbps: Math.round(toMbps(file.sizeBytes, hashMs) * 10) / 10,
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
