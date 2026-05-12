import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { Disk, Job } from "../api/types";
import {
  formatBytes,
  formatBytesPerSec,
  formatRate,
  formatDuration,
} from "../lib/format";
import { ProgressBar } from "./ProgressBar";
import { StatusBadge } from "./StatusBadge";

// ---------------------------------------------------------------------------
// Speed sample helpers
// ---------------------------------------------------------------------------

interface SpeedSample { t: number; items: number; bytes: number }

interface RatePoint {
  elapsed: number;   // seconds from job start
  filesPerSec: number;
  bytesPerSec: number;
}

function samplesToRates(samples: SpeedSample[], startedAtMs: number): RatePoint[] {
  const result: RatePoint[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dt = (cur.t - prev.t) / 1000;
    if (dt <= 0) continue;
    result.push({
      elapsed: (cur.t - startedAtMs) / 1000,
      filesPerSec: Math.max(0, (cur.items - prev.items) / dt),
      bytesPerSec: Math.max(0, (cur.bytes - prev.bytes) / dt),
    });
  }
  return result;
}

const INSTANT_WINDOW_MS = 5_000;

function computeInstantRates(
  samples: SpeedSample[] | undefined,
  nowMs: number
): { items: number; bytes: number } | null {
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

function computeElapsed(job: Job, now: number): number {
  if (!job.startedAt) return 0;
  const start = new Date(job.startedAt).getTime();
  const end =
    job.completedAt ? new Date(job.completedAt).getTime()
    : job.status === "paused" && job.updatedAt ? new Date(job.updatedAt).getTime()
    : now;
  return Math.max(0, (end - start) / 1000);
}

// ---------------------------------------------------------------------------
// Speed charts
// ---------------------------------------------------------------------------

function formatElapsed(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function SpeedChart({
  data,
  dataKey,
  color,
  yFormatter,
  tooltipFormatter,
  label,
}: {
  data: RatePoint[];
  dataKey: keyof RatePoint;
  color: string;
  yFormatter: (v: number) => string;
  tooltipFormatter: (v: number) => string;
  label: string;
}) {
  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-24 rounded-lg bg-zinc-900 border border-zinc-800">
        <p className="text-xs text-zinc-600">Collecting data…</p>
      </div>
    );
  }

  const gradId = `grad-${dataKey as string}`;

  return (
    <div className="space-y-1">
      <p className="text-xs text-zinc-500">{label}</p>
      <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
        <ResponsiveContainer width="100%" height={100}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="elapsed"
              tickFormatter={formatElapsed}
              tick={{ fontSize: 10, fill: "#52525b" }}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={yFormatter}
              tick={{ fontSize: 10, fill: "#52525b" }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip
              contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: "#71717a" }}
              labelFormatter={(v) => `t+${formatElapsed(v as number)}`}
              formatter={(v) => [tooltipFormatter(v as number), label]}
              cursor={{ stroke: "#3f3f46" }}
            />
            <Area
              type="monotone"
              dataKey={dataKey as string}
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#${gradId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat grid
// ---------------------------------------------------------------------------

function StatGrid({ stats }: { stats: Array<{ label: string; value: string; sub?: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

// ---------------------------------------------------------------------------
// JobDetails — the main export
// ---------------------------------------------------------------------------

export function JobDetails({
  job,
  now,
  disk,
  onPause,
  onResume,
  onCancel,
}: {
  job: Job;
  now: number;
  disk?: Disk | null;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}) {
  const isActive = ["running", "paused", "queued"].includes(job.status);
  const elapsedSec = computeElapsed(job, now);

  const avgFilesPerSec = elapsedSec > 0 ? job.itemsProcessed / elapsedSec : 0;
  const avgBytesPerSec = elapsedSec > 0 ? job.bytesProcessed / elapsedSec : 0;

  const samples = (job.progressJson as any)?.speedSamples as SpeedSample[] | undefined;
  const instant = computeInstantRates(samples, now);
  const filesPerSec = instant?.items ?? avgFilesPerSec;
  const bytesPerSec = instant?.bytes ?? avgBytesPerSec;

  const usedBytes =
    disk && disk.capacityBytes != null && disk.freeBytes != null
      ? Math.max(0, disk.capacityBytes - disk.freeBytes)
      : null;
  const remainingBytes = usedBytes != null ? Math.max(0, usedBytes - job.bytesProcessed) : null;
  const etaSec =
    job.status === "running" && remainingBytes != null && bytesPerSec > 0
      ? remainingBytes / bytesPerSec
      : null;

  const explicitProgress = (job.progressJson as any)?.progress as number | undefined;
  const derivedProgress =
    explicitProgress == null && usedBytes != null && usedBytes > 0
      ? Math.min(1, job.bytesProcessed / usedBytes)
      : null;
  const progress = explicitProgress ?? derivedProgress;

  const isCopy = job.type === "copy";
  const isScan = job.type === "scan";
  const dataPerSecLabel = isScan ? "Data scanned/s" : "Throughput";

  // Copy-specific progress: use totalFiles/totalBytes from progressJson
  const copyProgress = isCopy ? (job.progressJson as {
    totalFiles?: number;
    totalBytes?: number;
    copiedFiles?: number;
    copiedBytes?: number;
    skippedFiles?: number;
    errorFiles?: number;
    currentFile?: string | null;
  } | null) : null;

  const copyTotalBytes = copyProgress?.totalBytes ?? 0;
  const copyCopiedBytes = copyProgress?.copiedBytes ?? 0;
  const copyEtaSec =
    isCopy && job.status === "running" && bytesPerSec > 0 && copyTotalBytes > 0
      ? Math.max(0, (copyTotalBytes - copyCopiedBytes) / bytesPerSec)
      : null;

  const primaryStats = [
    { label: "Files", value: job.itemsProcessed.toLocaleString(),
      sub: isCopy && copyProgress?.totalFiles ? `/ ${copyProgress.totalFiles.toLocaleString()}` : undefined },
    { label: "Data", value: formatBytes(job.bytesProcessed),
      sub: isCopy && copyTotalBytes ? `/ ${formatBytes(copyTotalBytes)}` : undefined },
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

  const effectiveEta = isCopy ? copyEtaSec : etaSec;

  const secondaryStats = [
    { label: "Elapsed", value: formatDuration(elapsedSec) },
    { label: "ETA", value: effectiveEta != null ? formatDuration(effectiveEta) : "—" },
    { label: "Warnings", value: job.warningsCount.toString() },
    { label: "Errors", value: job.errorsCount.toString() },
  ];

  // Build chart data from speed samples
  const startedAtMs = job.startedAt ? new Date(job.startedAt).getTime() : 0;
  const rateData = samples && startedAtMs > 0 ? samplesToRates(samples, startedAtMs) : [];

  return (
    <div className="space-y-5">
      {/* Controls */}
      {isActive && (onPause || onResume || onCancel) && (
        <div className="flex gap-2">
          {job.status === "running" && onPause && (
            <button
              onClick={onPause}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-yellow-400 hover:bg-zinc-700 transition-colors"
            >
              Pause
            </button>
          )}
          {job.status === "paused" && onResume && (
            <button
              onClick={onResume}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-green-400 hover:bg-zinc-700 transition-colors"
            >
              Resume
            </button>
          )}
          {onCancel && (
            <button
              onClick={onCancel}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Progress bar */}
      {isCopy && copyTotalBytes > 0 && (
        <ProgressBar value={Math.min(1, copyCopiedBytes / copyTotalBytes)} />
      )}
      {!isCopy && progress != null && <ProgressBar value={progress} />}

      {/* Current file (copy jobs) */}
      {isCopy && copyProgress?.currentFile && job.status === "running" && (
        <p className="text-xs text-zinc-600 truncate font-mono">{copyProgress.currentFile}</p>
      )}

      {/* Copy skip/error summary */}
      {isCopy && ((copyProgress?.skippedFiles ?? 0) > 0 || (copyProgress?.errorFiles ?? 0) > 0) && (
        <div className="flex gap-3 text-xs">
          {(copyProgress?.skippedFiles ?? 0) > 0 && (
            <span className="text-yellow-500">{copyProgress!.skippedFiles} skipped</span>
          )}
          {(copyProgress?.errorFiles ?? 0) > 0 && (
            <span className="text-red-400">{copyProgress!.errorFiles} errors</span>
          )}
        </div>
      )}

      {/* Stats */}
      <StatGrid stats={primaryStats} />
      <StatGrid stats={secondaryStats} />

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SpeedChart
          data={rateData}
          dataKey="filesPerSec"
          color="#3b82f6"
          yFormatter={(v) => formatRate(v, "/s")}
          tooltipFormatter={(v) => formatRate(v, "/s")}
          label="Files/sec"
        />
        <SpeedChart
          data={rateData}
          dataKey="bytesPerSec"
          color="#8b5cf6"
          yFormatter={(v) => formatBytesPerSec(v)}
          tooltipFormatter={(v) => formatBytesPerSec(v)}
          label={dataPerSecLabel}
        />
      </div>

      {/* Footer note */}
      {!isCopy && usedBytes != null && (
        <p className="text-xs text-zinc-600">
          Progress and ETA estimated against {formatBytes(usedBytes)} of used disk space
          {disk?.label && <> on <span className="text-zinc-400">{disk.label}</span></>}.
          Total file count is unknown until scan completes.
        </p>
      )}
    </div>
  );
}

// Re-export StatusBadge convenience for pages that show the job header inline
export { StatusBadge };
