/**
 * media-metadata-worker.ts — Bun Worker for per-file EXIF/QuickTime extraction.
 *
 * The main thread sends a list of files; this worker walks them, calls
 * `extractFromPath`, and emits one `file_done` message per file. Decoupling
 * extraction from the main event loop keeps the API responsive during a long
 * extraction job on an HDD.
 *
 * Protocol (postMessage):
 *   Main → Worker:  { type: "start", files: Array<{ fileId, path, name }> }
 *   Main → Worker:  { type: "pause" } / { type: "resume" } / { type: "cancel" }
 *   Worker → Main:  { type: "file_done", fileId, metadata }
 *   Worker → Main:  { type: "done" }
 *   Worker → Main:  { type: "error", message }
 */

import { extractFromPath, type ExtractedMetadata } from "./extractor";

interface FileTarget {
  fileId: number;
  path: string;
  name: string;
}

type InboundMessage =
  | { type: "start"; files: FileTarget[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" };

let paused = false;
let cancelled = false;
let pauseResolve: (() => void) | null = null;

async function checkPauseOrCancel(): Promise<void> {
  if (cancelled) throw new Error("cancelled");
  if (!paused) return;
  await new Promise<void>((resolve) => {
    pauseResolve = resolve;
  });
  if (cancelled) throw new Error("cancelled");
}

async function run(files: FileTarget[]): Promise<void> {
  for (const file of files) {
    await checkPauseOrCancel();
    let metadata: ExtractedMetadata;
    try {
      metadata = await extractFromPath(file.path, file.name);
    } catch (err) {
      metadata = {
        datetimeOriginal: null,
        datetimeSource: "none",
        capturedAtUnix: null,
        make: null,
        model: null,
        extractionError: `worker_uncaught: ${(err as Error).message ?? String(err)}`,
      };
    }
    postMessage({ type: "file_done", fileId: file.fileId, metadata });
  }
  postMessage({ type: "done" });
}

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
