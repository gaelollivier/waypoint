import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Disk, DiffJobSummary, DuplicateJobSummary, Job, JobEvent } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { JobDetails } from "../components/JobDetails";
import { TreeExplorer } from "../components/TreeExplorer";
import { DiffExplorer } from "../components/DiffExplorer";
import { DuplicateExplorer } from "../components/DuplicateExplorer";
import { Link, navigate } from "../components/Router";
import { useLiveJob } from "../lib/useLiveJob";
import { formatBytes, formatDate } from "../lib/format";

type Tab = "overview" | "tree" | "diff" | "duplicates" | "events";

const ACTIVE = ["queued", "running", "paused"];

const LEVEL_COLORS: Record<JobEvent["level"], string> = {
  info:    "text-zinc-500",
  warning: "text-yellow-500",
  error:   "text-red-500",
};

export function DiskDetailPage({ id }: { id: string }) {
  const diskId = Number(id);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");

  const { data: disk, isLoading: diskLoading } = useQuery<Disk>({
    queryKey: ["disk", diskId],
    queryFn: () => api.disks.get(diskId),
    refetchInterval: 5_000,
  });

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ["jobs", { diskId }],
    queryFn: () => api.jobs.list({ targetDiskId: diskId, limit: 50 }),
    refetchInterval: 5_000,
  });

  const activeJob = jobs.find((j) => ACTIVE.includes(j.status)) ?? null;

  const scan = useMutation({
    mutationFn: () => api.disks.scan(diskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs", { diskId }] });
    },
    onError: (err: any) => alert(`Scan failed: ${err.message}`),
  });

  if (diskLoading) return <p className="text-sm text-zinc-500 p-6">Loading…</p>;
  if (!disk) return <p className="text-sm text-red-400 p-6">Disk not found.</p>;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/" className="text-xs text-zinc-500 hover:text-white transition-colors">
          ← Disks
        </Link>
      </div>

      <DiskHeader disk={disk} onScan={() => scan.mutate()} hasActiveJob={activeJob != null} />

      <div className="flex gap-1 border-b border-zinc-800">
        {(["overview", "tree", "diff", "duplicates", "events"] as Tab[]).map((t) => (
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
        <OverviewTab disk={disk} activeJob={activeJob} recentJobs={jobs} diskId={diskId} />
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

      {tab === "diff" && <DiffTab sourceDiskId={diskId} sourceDisk={disk} />}

      {tab === "duplicates" && <DuplicatesTab diskId={diskId} disk={disk} />}

      {tab === "events" && <EventsTab diskId={diskId} jobs={jobs} />}
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
  diskId,
}: {
  disk: Disk;
  activeJob: Job | null;
  recentJobs: Job[];
  diskId: number;
}) {
  const queryClient = useQueryClient();
  const { job: liveJob, now } = useLiveJob(activeJobStub?.id ?? null);

  const completedJobs = recentJobs
    .filter((j) => !ACTIVE.includes(j.status))
    .slice(0, 10);

  const handlePause = async () => {
    if (!liveJob) return;
    await api.jobs.pause(liveJob.id);
    queryClient.invalidateQueries({ queryKey: ["job", liveJob.id] });
  };
  const handleResume = async () => {
    if (!liveJob) return;
    await api.jobs.resume(liveJob.id);
    queryClient.invalidateQueries({ queryKey: ["job", liveJob.id] });
  };
  const handleCancel = async () => {
    if (!liveJob) return;
    if (!confirm("Cancel this job?")) return;
    await api.jobs.cancel(liveJob.id);
    queryClient.invalidateQueries({ queryKey: ["job", liveJob.id] });
    queryClient.invalidateQueries({ queryKey: ["jobs", { diskId }] });
  };

  return (
    <div className="space-y-6">
      {liveJob && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <StatusBadge status={liveJob.status} />
              <span className="font-mono text-sm uppercase text-zinc-300">{liveJob.type}</span>
              <span className="text-xs text-zinc-600">#{liveJob.id}</span>
            </div>
            <Link
              href={`/jobs/${liveJob.id}`}
              className="text-xs text-zinc-500 hover:text-white transition-colors"
            >
              Debug →
            </Link>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
            <JobDetails
              job={liveJob}
              now={now}
              disk={disk}
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
            />
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

// ── Diff tab ──────────────────────────────────────────────────────────────────

function DiffTab({ sourceDiskId, sourceDisk }: { sourceDiskId: number; sourceDisk: Disk }) {
  const queryClient = useQueryClient();
  // Which dest disk the user has selected for the current diff view
  const [selectedDestId, setSelectedDestId] = useState<number | null>(null);
  // Track the most-recently-started diff job id so we can poll for completion
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);

  // All registered disks (to populate the dest picker)
  const { data: allDisks = [] } = useQuery<Disk[]>({
    queryKey: ["disks"],
    queryFn: () => api.disks.list(),
    refetchInterval: 10_000,
  });
  const destDisks = allDisks;
  const isSameDisk = selectedDestId === sourceDiskId;

  // Past diff jobs for this source disk
  const { data: diffJobs = [], refetch: refetchDiffJobs } = useQuery<DiffJobSummary[]>({
    queryKey: ["diffJobs", sourceDiskId],
    queryFn: () => api.diff.jobs(sourceDiskId),
    refetchInterval: pendingJobId ? 2_000 : false,
  });

  // Latest completed diff for the selected dest disk
  const latestCompletedDiff = selectedDestId
    ? diffJobs.find((j) => j.destDiskId === selectedDestId && j.status === "completed")
    : null;

  // Pending/running diff for the selected dest
  const activeDiff = selectedDestId
    ? diffJobs.find(
        (j) =>
          j.destDiskId === selectedDestId &&
          (j.status === "running" || j.status === "queued" || j.status === "paused")
      )
    : null;

  // Stop polling when no active job remains
  if (pendingJobId && !activeDiff) {
    setPendingJobId(null);
    refetchDiffJobs();
  }

  const startDiff = useMutation({
    mutationFn: () => api.diff.start(sourceDiskId, selectedDestId!),
    onSuccess: (res) => {
      setPendingJobId(res.jobId);
      queryClient.invalidateQueries({ queryKey: ["diffJobs", sourceDiskId] });
    },
    onError: (err: any) => alert(`Diff failed to start: ${err.message}`),
  });

  const canStartDiff =
    selectedDestId != null &&
    !activeDiff &&
    sourceDisk.lastScanAt != null &&
    !startDiff.isPending;

  return (
    <div className="space-y-5">
      {/* Dest disk picker + action */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-zinc-500">Compare against:</label>
        {destDisks.length === 0 ? (
          <span className="text-xs text-zinc-600">No other disks registered.</span>
        ) : (
          <select
            value={selectedDestId ?? ""}
            onChange={(e) => {
              setSelectedDestId(e.target.value ? Number(e.target.value) : null);
            }}
            className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">— pick a disk —</option>
            {destDisks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label ?? d.diskUuid.slice(0, 8)}
                {d.id === sourceDiskId ? " (this disk)" : ""}
                {!d.isConnected ? " (offline)" : ""}
              </option>
            ))}
          </select>
        )}

        {selectedDestId && (
          <button
            disabled={!canStartDiff}
            onClick={() => startDiff.mutate()}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {activeDiff ? "Running…" : "Run Diff"}
          </button>
        )}

        {activeDiff && (
          <span className="text-xs text-zinc-500">
            Job #{activeDiff.id} — {activeDiff.status}…
          </span>
        )}
      </div>

      {/* Same-disk warning */}
      {isSameDisk && (
        <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/30 px-4 py-3 text-xs text-yellow-400">
          Comparing a disk against itself — results will show all files as "present" with no differences. This is safe but only useful for testing.
        </div>
      )}

      {/* No dest selected */}
      {!selectedDestId && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
          Select a destination disk above to view or run a diff.
        </div>
      )}

      {/* Source not scanned */}
      {selectedDestId && !sourceDisk.lastScanAt && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-yellow-400">
          This disk hasn't been scanned yet. Run a scan first.
        </div>
      )}

      {/* Active job progress placeholder */}
      {selectedDestId && activeDiff && !latestCompletedDiff && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
          Diff job #{activeDiff.id} is running — results will appear here when it completes.
        </div>
      )}

      {/* Diff explorer */}
      {selectedDestId && latestCompletedDiff && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-600">
            <span>
              Diff #{latestCompletedDiff.id} ·{" "}
              {latestCompletedDiff.completedAt ? formatDate(latestCompletedDiff.completedAt) : ""}
            </span>
            {activeDiff && (
              <span className="text-zinc-500">Newer diff running — refresh when done</span>
            )}
          </div>
          <DiffExplorer sourceDiskId={sourceDiskId} destDiskId={selectedDestId} />
        </div>
      )}

      {/* No completed diff yet */}
      {selectedDestId && !latestCompletedDiff && !activeDiff && sourceDisk.lastScanAt && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
          No diff results yet. Click "Run Diff" to compare with the selected destination disk.
        </div>
      )}
    </div>
  );
}

// ── Duplicates tab ────────────────────────────────────────────────────────────

function DuplicatesTab({ diskId, disk }: { diskId: number; disk: Disk }) {
  const queryClient = useQueryClient();
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);

  const { data: duplicateJobs = [], refetch: refetchDuplicateJobs } = useQuery<DuplicateJobSummary[]>({
    queryKey: ["duplicateJobs", diskId],
    queryFn: () => api.duplicates.jobs(diskId),
    refetchInterval: pendingJobId ? 2_000 : false,
  });

  const latestCompleted = duplicateJobs.find((j) => j.status === "completed") ?? null;
  const activeJob = duplicateJobs.find((j) =>
    j.status === "running" || j.status === "queued" || j.status === "paused"
  ) ?? null;

  // Stop polling once the active job disappears
  if (pendingJobId && !activeJob) {
    setPendingJobId(null);
    refetchDuplicateJobs();
  }

  const startDetection = useMutation({
    mutationFn: () => api.duplicates.start(diskId),
    onSuccess: (res) => {
      setPendingJobId(res.jobId);
      queryClient.invalidateQueries({ queryKey: ["duplicateJobs", diskId] });
    },
    onError: (err: any) => alert(`Failed to start: ${err.message}`),
  });

  const canStart = !activeJob && disk.lastScanAt != null && !startDetection.isPending;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          disabled={!canStart}
          onClick={() => startDetection.mutate()}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {activeJob ? "Running…" : "Run Duplicate Detection"}
        </button>

        {activeJob && (
          <span className="text-xs text-zinc-500">
            Job #{activeJob.id} — {activeJob.status}…
          </span>
        )}
      </div>

      {/* No scan yet */}
      {!disk.lastScanAt && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-yellow-400">
          This disk hasn't been scanned yet. Run a scan first.
        </div>
      )}

      {/* Running, no results yet */}
      {disk.lastScanAt && activeJob && !latestCompleted && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
          Duplicate detection job #{activeJob.id} is running — results will appear here when it completes.
        </div>
      )}

      {/* No results, not running */}
      {disk.lastScanAt && !latestCompleted && !activeJob && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
          No duplicate detection results yet. Click "Run Duplicate Detection" to scan this disk.
        </div>
      )}

      {/* Results */}
      {latestCompleted && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-600">
            <span>
              Job #{latestCompleted.id}
              {latestCompleted.completedAt
                ? " · " + new Date(latestCompleted.completedAt).toLocaleString()
                : ""}
            </span>
            {activeJob && (
              <span className="text-zinc-500">Newer job running — refresh when done</span>
            )}
          </div>
          <DuplicateExplorer diskId={diskId} duplicateJobId={latestCompleted.id} />
        </div>
      )}
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

// ── Events tab (disk-scoped) ──────────────────────────────────────────────────

function EventsTab({ diskId, jobs }: { diskId: number; jobs: Job[] }) {
  const [levelFilter, setLevelFilter] = useState("");
  const [jobFilter, setJobFilter] = useState<number | "">("");

  const hasActiveJob = jobs.some((j) => ACTIVE.includes(j.status));

  const { data: events = [], isLoading } = useQuery<JobEvent[]>({
    queryKey: ["diskEvents", diskId, levelFilter, jobFilter],
    queryFn: () =>
      api.disks.events(diskId, {
        level: levelFilter || undefined,
        jobId: jobFilter !== "" ? Number(jobFilter) : undefined,
        limit: 500,
      }),
    refetchInterval: hasActiveJob ? 3_000 : false,
  });

  // Jobs with events — all completed + active, most recent first
  const jobOptions = [...jobs].sort((a, b) => b.id - a.id);

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500"
        >
          <option value="">All levels</option>
          <option value="error">Errors</option>
          <option value="warning">Warnings</option>
          <option value="info">Info</option>
        </select>

        <select
          value={jobFilter}
          onChange={(e) => setJobFilter(e.target.value === "" ? "" : Number(e.target.value))}
          className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500"
        >
          <option value="">All jobs</option>
          {jobOptions.map((j) => (
            <option key={j.id} value={j.id}>
              #{j.id} {j.type} ({j.status})
            </option>
          ))}
        </select>

        <span className="text-xs text-zinc-600 self-center">
          {isLoading ? "Loading…" : `${events.length} events`}
        </span>
      </div>

      {/* Events list */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
        {events.length === 0 ? (
          <p className="p-4 text-sm text-zinc-600">
            {isLoading ? "Loading…" : "No events found."}
          </p>
        ) : (
          <div className="divide-y divide-zinc-800 max-h-[60vh] overflow-y-auto">
            {events.map((evt) => (
              <div key={evt.id} className="flex gap-3 px-4 py-2.5 hover:bg-zinc-800/50">
                <span className="font-mono text-xs text-zinc-700 shrink-0 pt-0.5 w-32 truncate">
                  {new Date(evt.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className={`text-xs shrink-0 pt-0.5 w-16 ${LEVEL_COLORS[evt.level]}`}>
                  {evt.level}
                </span>
                <span className="text-xs text-zinc-600 shrink-0 pt-0.5 w-10">
                  #{evt.jobId}
                </span>
                <span className="text-xs text-zinc-300 break-all">{evt.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
