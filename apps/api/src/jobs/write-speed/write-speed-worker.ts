/**
 * write-speed-worker.ts — Bun Worker that generates and writes test data.
 *
 * Runs entirely off the main thread so the API event loop stays responsive.
 * The actual write goes through writeGeneratedTestFileAtomic in the disk-writes
 * gateway — pause/resume/cancel are wired in through the onChunkWritten hook
 * (it's awaited per chunk, so we can both throw on cancel and block on pause
 * from there).
 *
 * Protocol (postMessage):
 *   Main → Worker:  { type: "start", ...params }
 *   Main → Worker:  { type: "pause" } / { type: "resume" } / { type: "cancel" }
 *   Worker → Main:  { type: "progress", bytesWritten: number }
 *   Worker → Main:  { type: "done", bytesWritten: number, elapsedMs: number }
 *   Worker → Main:  { type: "error", message: string }
 */

import { writeGeneratedTestFileAtomic } from "../../fs/disk-writes";

interface StartMessage {
  type: "start";
  destMountPath: string;
  fileUuid: string;
  totalBytes: number;
  mode: "null" | "random";
  tempSuffix: string;
}

type InboundMessage =
  | StartMessage
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" };

let paused = false;
let cancelled = false;
let pauseResolve: (() => void) | null = null;

const PROGRESS_INTERVAL_BYTES = 4 * 1024 * 1024;

async function checkPauseOrCancel(): Promise<void> {
  if (cancelled) throw new Error("cancelled");
  if (!paused) return;
  await new Promise<void>((resolve) => {
    pauseResolve = resolve;
  });
  if (cancelled) throw new Error("cancelled");
}

async function run(msg: StartMessage): Promise<void> {
  const t0 = performance.now();

  let bytesWritten = 0;
  let bytesSinceReport = 0;

  try {
    const result = await writeGeneratedTestFileAtomic({
      destMountPath: msg.destMountPath,
      fileUuid: msg.fileUuid,
      totalBytes: msg.totalBytes,
      mode: msg.mode,
      tempSuffix: msg.tempSuffix,
      onChunkWritten: async (bytes) => {
        bytesWritten += bytes;
        bytesSinceReport += bytes;
        if (bytesSinceReport >= PROGRESS_INTERVAL_BYTES) {
          bytesSinceReport = 0;
          postMessage({ type: "progress", bytesWritten });
        }
        // pause/cancel checkpoint runs per chunk — throwing here aborts the
        // streaming write inside the gateway and leaves the temp file behind
        // for later cleanup, matching the previous worker's behaviour.
        await checkPauseOrCancel();
      },
    });

    const elapsedMs = Math.round(performance.now() - t0);
    postMessage({ type: "done", bytesWritten: result.bytesWritten, elapsedMs });
  } catch (err: any) {
    if (err?.message === "cancelled") {
      // Main thread already knows about the cancellation; stay silent.
      return;
    }
    throw err;
  }
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "start":
      run(msg).catch((err) => {
        postMessage({ type: "error", message: err.message });
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
