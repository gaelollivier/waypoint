import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/client";
import type { Disk, Job, JobEvent } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { JobProgressPanel } from "../components/JobProgressPanel";
import { TreeExplorer } from "../components/TreeExplorer";
import { Link, navigate } from "../components/Router";
import { useLiveJob } from "../lib/useLiveJob";
import { formatBytes, formatDate } from "../lib/format";

type Tab = "overview" | "tree" | "events";

const ACTIVE = ["queued", "running", "paused"];

const LEVEL_COLORS: Record<JobEvent["level"], string> = {
  info:    "text-zinc-500",
  warning: "text-yellow-500",
  error:   "text-red-500",
};

export function DiskDetailPage({ id }: { id: string }) {
  const diskId = Number(id);
  const [disk, setDisk] = useState<Disk | null>(null);
  const [diskLoading, setDiskLoading] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tab, setTab] = useState<Tab>("overview");

  const loadDisk = useCallback(async () => {
    try {
      setDisk(await api.disks.get(diskId));
    } catch {
      setDisk(null);
    } finally {
      setDiskLoading(false);
    }
  }, [diskId]);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await api.jobs.list({ targetDiskId: diskId, limit: 50 }));
    } catch {}
  }, [diskId]);

  useEffect(() => { loadDisk(); loadJobs(); }, [loadDisk, loadJobs]);

  // Refresh jobs every 5s (cheap, doesn't compete with the active job's SSE)
  useEffect(() => {
    const t = setInterval(loadJobs, 5000);
    return () => clearInterval(t);
  }, [loadJobs]);

  // Find the currently-active job on this disk (running/paused/queued)
  const activeJob = jobs.find((j) => ACTIVE.includes(j.status)) ?? null;

  if (diskLoading) return <p className="text-sm text-zinc-500 p-6">Loading…</p>;
  if (!disk) return <p className="text-sm text-red-400 p-6">Disk not found.</p>;

  const startScan = async () => {
    try {
      await api.disks.scan(diskId);
      await loadJobs();
    } catch (err: any) {
      alert(`Scan failed: ${err.message}`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/" className="text-xs text-zinc-500 hover:text-white transition-colors">
          ← Disks
        </Link>
      </div>

      <DiskHeader disk={disk} onScan={startScan} hasActiveJob={activeJob != null} />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {(["overview", "tree", "events"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors ${
              tab === t
                ? "border-blue-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          disk={disk}
          activeJob={activeJob}
          recentJobs={jobs}
        />
      )}

      {tab === "tree" && (
        disk.lastScanAt ? (
          <TreeExplorer diskId={diskId} />
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
            This disk hasn't been scanned yet. Run a scan to populate the tree.
          </div>
        )
      )}

      {tab === "events" && <EventsTab activeJobId={activeJob?.id ?? null} />}
    </div>
  );
}

// ── Header card ──────────────────────────────────────────────────────────────

function DiskHeader({
  disk,
  onScan,
  hasActiveJob,
}: {
  disk: Disk;
  onScan: () => void;
  hasActiveJob: boolean;
}) {
  const usedBytes =
    disk.capacityBytes != null && disk.freeBytes != null
      ? disk.capacityBytes - disk.freeBytes
      : null;
  const usedPct = usedBytes != null && disk.capacityBytes
    ? usedBytes / disk.capacityBytes
    : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-white">
              {disk.label ?? disk.diskUuid.slice(0, 8)}
            </span>
            <span className={`inline-block w-2 h-2 rounded-full ${disk.isConnected ? "bg-green-400" : "bg-zinc-600"}`} />
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-zinc-500">
            <span className="uppercase">{disk.kind}</span>
            {disk.mountPath && <><span>·</span><span className="font-mono">{disk.mountPath}</span></>}
            <span>·</span>
            <span className="font-mono text-zinc-700">{disk.diskUuid.slice(0, 8)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {disk.isConnected && !hasActiveJob && (
            <button
              onClick={onScan}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
            >
              Scan
            </button>
          )}
        </div>
      </div>

      {disk.capacityBytes != null && (
        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-600"
              style={{ width: `${(usedPct ?? 0) * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{formatBytes(usedBytes)} used</span>
            <span>{formatBytes(disk.freeBytes)} free / {formatBytes(disk.capacityBytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  disk,
  activeJob: activeJobStub,
  recentJobs,
}: {
  disk: Disk;
  activeJob: Job | null;
  recentJobs: Job[];
}) {
  // Subscribe to live updates for the active job (if any). We pass the job id
  // through useLiveJob so we get SSE-driven progress without re-fetching.
  const { job: liveJob, now } = useLiveJob(activeJobStub?.id ?? null, { events: false });

  const completedJobs = recentJobs
    .filter((j) => !ACTIVE.includes(j.status))
    .slice(0, 10);

  return (
    <div className="space-y-6">
      {liveJob && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-white">
              Current job
            </h2>
            <Link
              href={`/jobs/${liveJob.id}`}
              className="text-xs text-zinc-500 hover:text-white transition-colors"
            >
              Full details →
            </Link>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <StatusBadge status={liveJob.status} />
              <span className="font-mono text-sm uppercase text-zinc-300">{liveJob.type}</span>
              <span className="text-xs text-zinc-600">#{liveJob.id}</span>
            </div>
            <JobProgressPanel job={liveJob} now={now} disk={disk} compact />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-white">History</h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <HistoryTile label="Last scan" at={disk.lastScanAt} />
          <HistoryTile label="Last backup" at={disk.lastBackupAt} />
          <HistoryTile label="Last verify" at={disk.lastVerifyAt} />
        </div>

        {completedJobs.length === 0 ? (
          <p className="text-xs text-zinc-600">No completed jobs on this disk yet.</p>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800">
            {completedJobs.map((j) => (
              <button
                key={j.id}
                onClick={() => navigate(`/jobs/${j.id}`)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition-colors"
              >
                <StatusBadge status={j.status} />
                <span className="font-mono text-xs uppercase text-zinc-400 w-16">{j.type}</span>
                <span className="text-xs text-zinc-600">#{j.id}</span>
                <span className="flex-1 text-xs text-zinc-500 truncate">
                  {j.itemsProcessed.toLocaleString()} files · {formatBytes(j.bytesProcessed)}
                </span>
                <span className="text-xs text-zinc-600 shrink-0">
                  {formatDate(j.completedAt ?? j.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryTile({ label, at }: { label: string; at: string | null }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-1">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm text-white">{at ? formatDate(at) : <span className="text-zinc-600">never</span>}</p>
    </div>
  );
}

// ── Events tab ───────────────────────────────────────────────────────────────

function EventsTab({ activeJobId }: { activeJobId: number | null }) {
  // Events on this disk = events from the currently-active job, if any.
  // (Disk-wide event aggregation across historical jobs is a future feature.)
  const { events } = useLiveJob(activeJobId, { events: true });
  const eventsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (activeJobId == null) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
        No job is currently active on this disk.
        <p className="text-xs text-zinc-700 mt-2">
          Open a past job from the Overview tab to see its events.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
      {events.length === 0 ? (
        <p className="p-4 text-sm text-zinc-600">No events yet.</p>
      ) : (
        <div className="divide-y divide-zinc-800 max-h-[60vh] overflow-y-auto">
          {events.map((evt) => (
            <div key={evt.id} className="flex gap-3 px-4 py-2.5 hover:bg-zinc-800/50">
              <span className="font-mono text-xs text-zinc-700 shrink-0 pt-0.5">
                {new Date(evt.timestamp).toLocaleTimeString()}
              </span>
              <span className={`text-xs shrink-0 pt-0.5 w-16 ${LEVEL_COLORS[evt.level]}`}>
                {evt.level}
              </span>
              <span className="text-xs text-zinc-300 break-all">{evt.message}</span>
            </div>
          ))}
          <div ref={eventsEndRef} />
        </div>
      )}
    </div>
  );
}
