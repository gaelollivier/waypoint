import type { Disk, Job } from "../api/types";
import {
  formatBytes,
  formatBytesPerSec,
  formatRate,
  formatDuration,
} from "../lib/format";
import { ProgressBar } from "./ProgressBar";

/**
 * Computes elapsed seconds for a job, against a clock. Paused jobs freeze at
 * their last `updated_at` since we don't track active-only time.
 */
function computeElapsed(job: Job, now: number): number {
  if (!job.startedAt) return 0;
  const start = new Date(job.startedAt).getTime();
  const end =
    job.completedAt ? new Date(job.completedAt).getTime()
    : job.status === "paused" && job.updatedAt ? new Date(job.updatedAt).getTime()
    : now;
  return Math.max(0, (end - start) / 1000);
}

interface SpeedSample { t: number; items: number; bytes: number }

const INSTANT_WINDOW_MS = 5_000;

/**
 * Computes the "instant" rate from the most recent samples. We pick the oldest
 * sample within the window and compare it to the latest, dividing the deltas
 * by the wall-clock gap. Returns null if there aren't at least two samples in
 * the window or the gap is zero.
 */
function computeInstantRates(samples: SpeedSample[] | undefined, nowMs: number): { items: number; bytes: number } | null {
  if (!samples || samples.length < 2) return null;
  const cutoff = nowMs - INSTANT_WINDOW_MS;
  let firstIdx = samples.findIndex((s) => s.t >= cutoff);
  if (firstIdx === -1 || firstIdx === samples.length - 1) firstIdx = samples.length - 2;
  const first = samples[firstIdx];
  const last = samples[samples.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  return {
    items: Math.max(0, (last.items - first.items) / dt),
    bytes: Math.max(0, (last.bytes - first.bytes) / dt),
  };
}

/**
 * Shared live-progress visualisation for any active job. Used by JobDetailPage
 * (full view) and DiskDetailPage (overview tab summary).
 *
 * `disk` (optional) is used for ETA — projects against disk used-bytes since
 * the total file count isn't known until a scan completes.
 *
 * `compact` mode hides the secondary stats (warnings/errors row) and the
 * footer caption — for embedding inside a smaller card.
 */
export function JobProgressPanel({
  job,
  now,
  disk,
  compact = false,
}: {
  job: Job;
  now: number;
  disk?: Disk | null;
  compact?: boolean;
}) {
  const elapsedSec = computeElapsed(job, now);
  const avgFilesPerSec = elapsedSec > 0 ? job.itemsProcessed / elapsedSec : 0;
  const avgBytesPerSec = elapsedSec > 0 ? job.bytesProcessed / elapsedSec : 0;

  // Instant rates derived from the server-side speed-sample buffer (last ~5s).
  // For ETA we prefer the instant rate when available — it reflects current
  // conditions better than a since-start average.
  const samples = (job.progressJson as any)?.speedSamples as SpeedSample[] | undefined;
  const instant = computeInstantRates(samples, now);
  const filesPerSec = instant?.items ?? avgFilesPerSec;
  const bytesPerSec = instant?.bytes ?? avgBytesPerSec;

  const usedBytes =
    disk && disk.capacityBytes != null && disk.freeBytes != null
      ? Math.max(0, disk.capacityBytes - disk.freeBytes)
      : null;
  const remainingBytes =
    usedBytes != null ? Math.max(0, usedBytes - job.bytesProcessed) : null;
  const etaSec =
    job.status === "running" && remainingBytes != null && bytesPerSec > 0
      ? remainingBytes / bytesPerSec
      : null;

  // Progress: prefer an explicit value from progress_json, otherwise derive it
  // from bytes covered vs disk used-bytes. For scans this is "logical bytes
  // encountered / total used bytes" — both sides are sums of file sizes, so
  // the ratio is meaningful as a coverage estimate.
  const explicitProgress = (job.progressJson as any)?.progress as number | undefined;
  const derivedProgress =
    explicitProgress == null && usedBytes != null && usedBytes > 0
      ? Math.min(1, job.bytesProcessed / usedBytes)
      : null;
  const progress = explicitProgress ?? derivedProgress;
  const showProgressBar = (job.status === "running" || progress != null) && progress != null;

  // For scan jobs, "bytes/sec" is logical (sum of file sizes encountered per
  // second), not actual disk I/O — sampled hashing reads ~50 KB regardless of
  // file size. Label accordingly so the metric isn't misread as I/O throughput.
  const isScan = job.type === "scan";
  const dataPerSecLabel = isScan ? "Data scanned/s" : "Throughput";

  // Show instant rate as primary; tuck average into the same tile as a
  // secondary line for at-a-glance comparison.
  const primaryStats: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Files", value: job.itemsProcessed.toLocaleString() },
    { label: "Data", value: formatBytes(job.bytesProcessed) },
    {
      label: "Files/sec",
      value: formatRate(filesPerSec, "/s"),
      sub: instant ? `avg ${formatRate(avgFilesPerSec, "/s")}` : undefined,
    },
    {
      label: dataPerSecLabel,
      value: formatBytesPerSec(bytesPerSec),
      sub: instant ? `avg ${formatBytesPerSec(avgBytesPerSec)}` : undefined,
    },
  ];
  const secondaryStats = [
    { label: "Elapsed", value: formatDuration(elapsedSec) },
    { label: "ETA", value: etaSec != null ? formatDuration(etaSec) : "—" },
    { label: "Warnings", value: job.warningsCount.toString() },
    { label: "Errors", value: job.errorsCount.toString() },
  ];

  return (
    <div className="space-y-4">
      {showProgressBar && <ProgressBar value={progress ?? 0} />}

      <StatGrid stats={primaryStats} />
      {!compact && <StatGrid stats={secondaryStats} />}
      {compact && (
        <p className="text-xs text-zinc-600">
          Elapsed {formatDuration(elapsedSec)}
          {etaSec != null && <> · ETA {formatDuration(etaSec)}</>}
          {job.errorsCount > 0 && <> · <span className="text-red-400">{job.errorsCount} errors</span></>}
          {job.warningsCount > 0 && <> · <span className="text-yellow-400">{job.warningsCount} warnings</span></>}
        </p>
      )}

      {!compact && usedBytes != null && (
        <p className="text-xs text-zinc-600">
          Progress and ETA estimated against {formatBytes(usedBytes)} of used disk space
          {disk?.label && <> on <span className="text-zinc-400">{disk.label}</span></>}.
          Total file count is unknown until scan completes.
        </p>
      )}
    </div>
  );
}

function StatGrid({ stats }: { stats: Array<{ label: string; value: string; sub?: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {stats.map(({ label, value, sub }) => (
        <div key={label} className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-1">
          <p className="text-xs text-zinc-500">{label}</p>
          <p className="text-xl font-mono font-semibold text-white">{value}</p>
          {sub && <p className="text-xs font-mono text-zinc-500">{sub}</p>}
        </div>
      ))}
    </div>
  );
}
