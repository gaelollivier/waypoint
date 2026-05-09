/**
 * Diagnostic trace logger. Writes timestamped JSONL lines to a separate file
 * (default: `/tmp/waypoint-trace.log`) so we can post-mortem freezes/stalls
 * without polluting the main API log.
 *
 * Each line: { t: ISO, ms: <perf relative>, kind: string, ...payload }.
 * The `ms` field is `performance.now()` rounded; useful for measuring small
 * intervals when wall-clock ISO resolution (1ms) is enough but you also want
 * a stable monotonic reference.
 */

import { appendLineSync } from "../fs/disk-io";

const TRACE_PATH = process.env.WAYPOINT_TRACE_PATH ?? "/tmp/waypoint-trace.log";
const ENABLED = process.env.WAYPOINT_TRACE !== "0";

export function trace(kind: string, payload: Record<string, unknown> = {}): void {
  if (!ENABLED) return;
  // Spread payload first so a caller's `kind` / `t` / `since_start_ms` field
  // can't accidentally clobber the framing.
  const line = JSON.stringify({
    ...payload,
    t: new Date().toISOString(),
    since_start_ms: Math.round(performance.now()),
    kind,
  });
  appendLineSync(TRACE_PATH, line);
}

/**
 * Event-loop stall detector. A 50ms timer that records the gap between ticks;
 * if the gap exceeds `thresholdMs`, logs a `loop_stall` event.
 *
 * The detector is the cheapest possible signal that the main loop is starved.
 * Combined with walker/flush traces, the timeline lets us pinpoint *which*
 * synchronous segment held the loop.
 */
export function startLoopStallDetector(thresholdMs = 250): () => void {
  let last = performance.now();
  const interval = 50;
  const t = setInterval(() => {
    const now = performance.now();
    const drift = now - last - interval;
    if (drift > thresholdMs) {
      trace("loop_stall", { drift_ms: Math.round(drift) });
    }
    last = now;
  }, interval);
  // Don't keep the process alive just for the detector.
  (t as any).unref?.();
  return () => clearInterval(t);
}
