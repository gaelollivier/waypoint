/**
 * write-speed-worker.ts — Bun Worker that generates and writes test data.
 *
 * Runs entirely off the main thread so the API event loop stays responsive.
 * All file I/O happens here; the main thread only receives progress messages.
 *
 * This file intentionally uses fs/path directly (not disk-reads/disk-writes)
 * because Workers can't share the main thread's module singletons, and the
 * guardrails (path containment, exclusive create, no overwrite) are replicated
 * inline below.
 *
 * Protocol (postMessage):
 *   Main → Worker:  { type: "start", ...params }
 *   Main → Worker:  { type: "pause" } / { type: "resume" } / { type: "cancel" }
 *   Worker → Main:  { type: "progress", bytesWritten: number }
 *   Worker → Main:  { type: "done", bytesWritten: number, elapsedMs: number }
 *   Worker → Main:  { type: "error", message: string }
 */

import { open, rename } from "fs/promises";
import path from "path";

// -- Types for messages between main thread and worker ----------------------

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

// -- State ------------------------------------------------------------------

let paused = false;
let cancelled = false;
let pauseResolve: (() => void) | null = null;

// -- Helpers ----------------------------------------------------------------

const CHUNK_SIZE = 1024 * 1024; // 1 MB
const PROGRESS_INTERVAL_BYTES = 4 * 1024 * 1024; // report every 4 MB

function fillRandom(chunk: Uint8Array): void {
  const max = 65_536;
  for (let offset = 0; offset < chunk.byteLength; offset += max) {
    crypto.getRandomValues(
      chunk.subarray(offset, Math.min(offset + max, chunk.byteLength))
    );
  }
}

async function checkPauseOrCancel(): Promise<void> {
  if (cancelled) throw new Error("cancelled");
  if (!paused) return;
  await new Promise<void>((resolve) => {
    pauseResolve = resolve;
  });
  if (cancelled) throw new Error("cancelled");
}

// -- Main write logic -------------------------------------------------------

async function run(msg: StartMessage): Promise<void> {
  const { destMountPath, fileUuid, totalBytes, mode, tempSuffix } = msg;
  const t0 = performance.now();

  // Validate inputs
  if (!/^[0-9a-f-]{36}$/i.test(fileUuid)) {
    throw new Error(`Invalid UUID: ${fileUuid}`);
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error("totalBytes must be a positive safe integer");
  }

  const relativePath = `.waypoint-test-copy-${fileUuid}`;
  const destAbsPath = path.join(destMountPath, relativePath);
  const tempPath = destAbsPath + `.write-speed-tmp-${tempSuffix}`;
  const resolvedMount = path.resolve(destMountPath);

  // Path containment
  if (!path.resolve(destAbsPath).startsWith(resolvedMount)) {
    throw new Error(`Dest path escapes disk mount: ${relativePath}`);
  }
  if (!path.resolve(tempPath).startsWith(resolvedMount)) {
    throw new Error(`Temp path escapes disk mount`);
  }

  // Dest existence guard
  if (await Bun.file(destAbsPath).exists()) {
    throw new Error(`File already exists at destination: ${destAbsPath}`);
  }

  // Exclusive create for temp file
  let fh;
  try {
    fh = await open(tempPath, "wx");
  } catch (err: any) {
    if (err.code === "EEXIST") {
      throw new Error(`Temp file already exists: ${tempPath}`);
    }
    throw err;
  }

  let bytesWritten = 0;
  let bytesSinceReport = 0;

  try {
    let remaining = totalBytes;
    while (remaining > 0) {
      await checkPauseOrCancel();

      const size = Math.min(CHUNK_SIZE, remaining);
      const chunk = new Uint8Array(size);
      if (mode === "random") fillRandom(chunk);

      await fh.write(chunk);
      bytesWritten += size;
      bytesSinceReport += size;
      remaining -= size;

      if (bytesSinceReport >= PROGRESS_INTERVAL_BYTES) {
        bytesSinceReport = 0;
        postMessage({ type: "progress", bytesWritten });
      }
    }
  } catch (err: any) {
    // On cancel, close the handle but don't rename — leave the temp file
    await fh.close();
    if (err.message === "cancelled") {
      // Not an error — the main thread already knows about the cancellation
      return;
    }
    throw err;
  }

  await fh.close();

  // Atomic rename
  await rename(tempPath, destAbsPath);

  const elapsedMs = Math.round(performance.now() - t0);
  postMessage({ type: "done", bytesWritten, elapsedMs });
}

// -- Message handler --------------------------------------------------------

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
      // If paused, unblock so the loop can exit
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
      break;
  }
};
