import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Disk, DiffJobSummary, DuplicateJobSummary, DuplicateScanSummary, Job, JobEvent } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { JobDetails } from "../components/JobDetails";
import { TreeExplorer } from "../components/TreeExplorer";
import { DiffExplorer } from "../components/DiffExplorer";
import { DuplicateExplorer, CleanupProgressDialogBody } from "../components/DuplicateExplorer";
import { AgentNotesTab } from "../components/AgentNotesTab";
import { CleanupSuggestionsTab } from "../components/CleanupSuggestionsTab";
import { Link, navigate } from "../components/Router";
import { useLiveJob } from "../lib/useLiveJob";
import { formatBytes, formatDate } from "../lib/format";
import { useSearchParam, setSearchParams } from "../lib/urlState";

type Tab = "overview" | "tree" | "diff" | "duplicates" | "suggestions" | "notes" | "events";
const VALID_TABS: Tab[] = ["overview", "tree", "diff", "duplicates", "suggestions", "notes", "events"];

const ACTIVE = ["queued", "running", "paused"];

const LEVEL_COLORS: Record<JobEvent["level"], string> = {
  info:    "text-zinc-500",
  warning: "text-yellow-500",
  error:   "text-red-500",
};

export function DiskDetailPage({ id }: { id: string }) {
  const diskId = Number(id);
  const queryClient = useQueryClient();
  const [showScanDialog, setShowScanDialog] = useState(false);

  // Tab state from URL — defaults to "overview"
  const rawTab = useSearchParam("tab");
  const tab: Tab = rawTab && VALID_TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "overview";
  const setTab = (t: Tab) => setSearchParams({ tab: t === "overview" ? null : t });

  // Diff dest disk from URL
  const rawDest = useSearchParam("dest");
  const urlDestDiskId = rawDest ? Number(rawDest) : null;

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
    mutationFn: (body: { fullHash: boolean }) => api.disks.scan(diskId, body),
    onSuccess: () => {
      setShowScanDialog(false);
      queryClient.invalidateQueries({ queryKey: ["jobs", { diskId }] });
    },
    onError: (err: any) => alert(`Scan failed: ${err.message}`),
  });

  const writeSpeedTest = useMutation({
    mutationFn: (body: { sizeBytes: number; mode: "null" | "random" }) =>
      api.disks.writeSpeedTest(diskId, body),
    onSuccess: ({ jobId }) => {
      queryClient.invalidateQueries({ queryKey: ["jobs", { diskId }] });
      navigate(`/jobs/${jobId}`);
    },
    onError: (err: any) => alert(`Write speed test failed: ${err.message}`),
  });

  const startWriteSpeedTest = () => {
    const rawGb = prompt("Write speed test size in GB", "1");
    if (rawGb == null) return;
    const gb = Number(rawGb);
    if (!Number.isFinite(gb) || gb <= 0) {
      alert("Enter a positive size in GB.");
      return;
    }
    const mode = confirm("Use random data? Cancel uses null data.") ? "random" : "null";
    writeSpeedTest.mutate({
      sizeBytes: Math.round(gb * 1024 * 1024 * 1024),
      mode,
    });
  };

  const readSpeedTest = useMutation({
    mutationFn: (body: { sampleCount: number }) =>
      api.disks.readSpeedTest(diskId, body),
    onSuccess: ({ jobId }) => {
      queryClient.invalidateQueries({ queryKey: ["jobs", { diskId }] });
      navigate(`/jobs/${jobId}`);
    },
    onError: (err: any) => alert(`Read speed test failed: ${err.message}`),
  });

  const startReadSpeedTest = () => {
    const rawCount = prompt("Number of files to benchmark (largest files)", "5");
    if (rawCount == null) return;
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count <= 0) {
      alert("Enter a positive integer.");
      return;
    }
    readSpeedTest.mutate({ sampleCount: count });
  };

  if (diskLoading) return <p className="text-sm text-zinc-500 p-6">Loading…</p>;
  if (!disk) return <p className="text-sm text-red-400 p-6">Disk not found.</p>;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/" className="text-xs text-zinc-500 hover:text-white transition-colors">
          ← Disks
        </Link>
      </div>

      <DiskHeader
        disk={disk}
        onScan={() => setShowScanDialog(true)}
        onWriteSpeedTest={startWriteSpeedTest}
        onReadSpeedTest={startReadSpeedTest}
        hasActiveJob={activeJob != null}
      />

      <div className="flex gap-1 border-b border-zinc-800 overflow-x-auto">
        {(["overview", "tree", "diff", "duplicates", "suggestions", "notes", "events"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors whitespace-nowrap ${
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

      {tab === "diff" && (
        <DiffTab
          sourceDiskId={diskId}
          sourceDisk={disk}
          selectedDestId={urlDestDiskId}
          onSelectDest={(destId) => setSearchParams({ dest: destId != null ? String(destId) : null })}
        />
      )}

      {tab === "duplicates" && <DuplicatesTab diskId={diskId} disk={disk} />}

      {tab === "suggestions" && <CleanupSuggestionsTab diskId={diskId} />}

      {tab === "notes" && <AgentNotesTab diskId={diskId} />}

      {tab === "events" && <EventsTab diskId={diskId} jobs={jobs} />}

      {showScanDialog && (
        <ScanOptionsDialog
          isPending={scan.isPending}
          onConfirm={(fullHash) => scan.mutate({ fullHash })}
          onClose={() => setShowScanDialog(false)}
        />
      )}
    </div>
  );
}

// ── Header card ──────────────────────────────────────────────────────────────

function DiskHeader({
  disk,
  onScan,
  onWriteSpeedTest,
  onReadSpeedTest,
  hasActiveJob,
}: {
  disk: Disk;
  onScan: () => void;
  onWriteSpeedTest: () => void;
  onReadSpeedTest: () => void;
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
            <>
              <button
                onClick={onReadSpeedTest}
                className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                Test read
              </button>
              <button
                onClick={onWriteSpeedTest}
                className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                Test write
              </button>
              <button
                onClick={onScan}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
              >
                Scan
              </button>
            </>
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

// ── Scan options dialog ──────────────────────────────────────────────────────

function ScanOptionsDialog({
  isPending,
  onConfirm,
  onClose,
}: {
  isPending: boolean;
  onConfirm: (fullHash: boolean) => void;
  onClose: () => void;
}) {
  const [fullHash, setFullHash] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-white">Start Scan</h2>
          <p className="text-sm text-zinc-500">
            Choose whether this scan should read every byte and compute a fresh full hash for every file.
          </p>
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={fullHash}
            onChange={(e) => setFullHash(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium text-zinc-200">
              Read every byte and compute full hashes
            </span>
            <span className="block text-xs leading-relaxed text-zinc-500">
              Slower than a standard scan, but it can catch corruption outside sampled regions and records fresh full hashes for later workflows such as faster duplicate cleanup.
            </span>
          </span>
        </label>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={isPending}
            onClick={() => onConfirm(fullHash)}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? "Starting…" : "Start Scan"}
          </button>
        </div>
      </div>
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

function DiffTab({
  sourceDiskId,
  sourceDisk,
  selectedDestId,
  onSelectDest,
}: {
  sourceDiskId: number;
  sourceDisk: Disk;
  selectedDestId: number | null;
  onSelectDest: (destId: number | null) => void;
}) {
  const queryClient = useQueryClient();
  const [showCopyDialog, setShowCopyDialog] = useState(false);

  // All registered disks (to populate the dest picker)
  const { data: allDisks = [] } = useQuery<Disk[]>({
    queryKey: ["disks"],
    queryFn: () => api.disks.list(),
    refetchInterval: 10_000,
  });
  const destDisks = allDisks;
  const destDisk = selectedDestId ? allDisks.find((d) => d.id === selectedDestId) : null;
  const isSameDisk = selectedDestId === sourceDiskId;

  // Past diff jobs for this source disk
  const { data: diffJobs = [], refetch: refetchDiffJobs } = useQuery<DiffJobSummary[]>({
    queryKey: ["diffJobs", sourceDiskId],
    queryFn: () => api.diff.jobs(sourceDiskId),
    refetchInterval: 5_000,
  });

  // Latest completed diff for the selected dest disk
  const latestCompletedDiff = selectedDestId
    ? diffJobs.find((j) => j.destDiskId === selectedDestId && j.status === "completed")
    : null;

  // Diff tree root data (for copy summary — only fetched when we have a completed diff)
  const { data: diffRoot } = useQuery({
    queryKey: ["diffRoot", sourceDiskId, selectedDestId, latestCompletedDiff?.id],
    queryFn: () => api.diff.tree(sourceDiskId, selectedDestId!, { diffJobId: latestCompletedDiff!.id }),
    enabled: !!latestCompletedDiff && !!selectedDestId,
    staleTime: 30_000,
  });

  // Pending/running diff for the selected dest
  const activeDiff = selectedDestId
    ? diffJobs.find(
        (j) =>
          j.destDiskId === selectedDestId &&
          (j.status === "running" || j.status === "queued" || j.status === "paused")
      )
    : null;

  // Active/paused copy job on the dest disk
  const { data: activeCopyJobs = [] } = useQuery<Job[]>({
    queryKey: ["activeCopyJobs", selectedDestId],
    queryFn: () => api.jobs.list({ type: "copy", limit: 5 }),
    enabled: !!selectedDestId,
    refetchInterval: 5_000,
  });
  const activeCopy = activeCopyJobs.find(
    (j) => j.destDiskId === selectedDestId && ["queued", "running", "paused"].includes(j.status)
  ) ?? null;

  // Live job data for the active diff (SSE-powered progress)
  const { job: liveJob, now } = useLiveJob(activeDiff?.id ?? null);

  // Live copy job progress
  const { job: liveCopyJob, now: copyNow } = useLiveJob(activeCopy?.id ?? null);

  const startDiff = useMutation({
    mutationFn: () => api.diff.start(sourceDiskId, selectedDestId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["diffJobs", sourceDiskId] });
    },
    onError: (err: any) => alert(`Diff failed to start: ${err.message}`),
  });

  const startCopy = useMutation({
    mutationFn: () =>
      api.copy.start(sourceDiskId, selectedDestId!, latestCompletedDiff!.id),
    onSuccess: () => {
      setShowCopyDialog(false);
      queryClient.invalidateQueries({ queryKey: ["activeCopyJobs", selectedDestId] });
      queryClient.invalidateQueries({ queryKey: ["jobs", { diskId: sourceDiskId }] });
    },
    onError: (err: any) => alert(`Copy failed to start: ${err.message}`),
  });

  const canStartDiff =
    selectedDestId != null &&
    !activeDiff &&
    sourceDisk.lastScanAt != null &&
    !startDiff.isPending;

  const canStartCopy =
    latestCompletedDiff != null &&
    !activeDiff &&
    !activeCopy &&
    !isSameDisk &&
    destDisk?.isConnected &&
    diffRoot != null &&
    (diffRoot.totalAdded + diffRoot.totalChanged) > 0;

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
              onSelectDest(e.target.value ? Number(e.target.value) : null);
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

        {canStartCopy && (
          <button
            onClick={() => setShowCopyDialog(true)}
            className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 transition-colors"
          >
            Start Copy
          </button>
        )}

        {activeCopy && (
          <Link
            href={`/jobs/${activeCopy.id}`}
            className="text-xs text-zinc-500 hover:text-white transition-colors"
          >
            Copy job #{activeCopy.id} — {activeCopy.status}
          </Link>
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

      {/* Active diff progress indicator */}
      {selectedDestId && activeDiff && (
        <DiffProgressCard job={liveJob} fallback={activeDiff} now={now} />
      )}

      {/* Active copy job progress */}
      {selectedDestId && activeCopy && liveCopyJob && (
        <CopyProgressCard job={liveCopyJob} now={copyNow} destDisk={destDisk} />
      )}

      {/* Diff explorer */}
      {selectedDestId && latestCompletedDiff && !activeDiff && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-600">
            <span>
              Diff #{latestCompletedDiff.id} ·{" "}
              {latestCompletedDiff.completedAt ? formatDate(latestCompletedDiff.completedAt) : ""}
            </span>
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

      {/* Copy confirmation dialog */}
      {showCopyDialog && diffRoot && destDisk && (
        <CopyConfirmDialog
          diffRoot={diffRoot}
          destDisk={destDisk}
          isPending={startCopy.isPending}
          onConfirm={() => startCopy.mutate()}
          onClose={() => setShowCopyDialog(false)}
        />
      )}
    </div>
  );
}

// ── Copy confirmation dialog ────────────────────────────────────────────────

function CopyConfirmDialog({
  diffRoot,
  destDisk,
  isPending,
  onConfirm,
  onClose,
}: {
  diffRoot: import("../api/types").DiffTreeResponse;
  destDisk: Disk;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const filesToCopy = diffRoot.totalAdded + diffRoot.totalChanged;
  const bytesToCopy = diffRoot.totalAddedBytes + diffRoot.totalChangedBytes;
  const alreadyPresent = diffRoot.totalPresent;
  const freeBytes = destDisk.freeBytes;
  const estimatedFreeAfter = freeBytes != null ? freeBytes - bytesToCopy : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white">Start Copy</h2>

        <div className="space-y-3">
          <SummaryRow label="Files to copy" value={`${filesToCopy.toLocaleString()} files`} sub={formatBytes(bytesToCopy)} />
          {diffRoot.totalChanged > 0 && (
            <SummaryRow
              label="  Changed files"
              value={`${diffRoot.totalChanged.toLocaleString()} files`}
              sub={formatBytes(diffRoot.totalChangedBytes)}
              className="text-yellow-400"
            />
          )}
          <SummaryRow label="Already present" value={`${alreadyPresent.toLocaleString()} files`} sub={formatBytes(diffRoot.totalPresentBytes)} className="text-zinc-500" />
          <div className="border-t border-zinc-800" />
          <SummaryRow label="Dest free space" value={formatBytes(freeBytes)} />
          <SummaryRow
            label="After copy"
            value={formatBytes(estimatedFreeAfter)}
            className={estimatedFreeAfter != null && estimatedFreeAfter < 0 ? "text-red-400" : "text-zinc-300"}
          />
        </div>

        {estimatedFreeAfter != null && estimatedFreeAfter < 0 && (
          <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3 text-xs text-red-400">
            Not enough free space on the destination disk.
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={isPending || (estimatedFreeAfter != null && estimatedFreeAfter < 0)}
            onClick={onConfirm}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? "Starting…" : "Start Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  sub,
  className = "text-zinc-300",
}: {
  label: string;
  value: string;
  sub?: string;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-zinc-400">{label}</span>
      <div className="text-right">
        <span className={`text-sm font-medium ${className}`}>{value}</span>
        {sub && <span className="ml-2 text-xs text-zinc-600">{sub}</span>}
      </div>
    </div>
  );
}

// ── Copy progress card (in diff tab) ────────────────────────────────────────

function CopyProgressCard({
  job,
  now,
  destDisk,
}: {
  job: Job;
  now: number;
  destDisk: Disk | null | undefined;
}) {
  const p = job.progressJson as {
    totalFiles?: number;
    totalBytes?: number;
    copiedFiles?: number;
    copiedBytes?: number;
    skippedFiles?: number;
    errorFiles?: number;
    pendingFiles?: number;
    pendingBytes?: number;
    currentFile?: string | null;
    currentFileBytes?: number;
    currentFileBytesCopied?: number;
    diskFreeBytes?: number | null;
  } | null;

  const totalFiles = p?.totalFiles ?? 0;
  const copiedFiles = p?.copiedFiles ?? 0;
  const copiedBytes = p?.copiedBytes ?? 0;
  const totalBytes = p?.totalBytes ?? 0;
  const progress = totalBytes > 0 ? copiedBytes / totalBytes : 0;
  const currentFile = p?.currentFile;
  const startedAt = job.startedAt;
  const elapsed = startedAt ? Math.max(0, (now - new Date(startedAt).getTime()) / 1000) : 0;

  const bytesPerSec = elapsed > 0 ? copiedBytes / elapsed : 0;
  const remainingBytes = Math.max(0, p?.pendingBytes ?? (totalBytes - copiedBytes));
  const pendingFiles = p?.pendingFiles ?? Math.max(0, totalFiles - copiedFiles);
  const eta = bytesPerSec > 0 ? remainingBytes / bytesPerSec : null;
  const currentFileBytes = p?.currentFileBytes ?? 0;
  const currentFileBytesCopied = Math.min(currentFileBytes, p?.currentFileBytesCopied ?? 0);
  const showCurrentFileProgress =
    !!currentFile && job.status === "running" && currentFileBytes >= 100 * 1024 * 1024;

  const fmtEta = eta != null
    ? eta < 60 ? `${Math.round(eta)}s`
      : eta < 3600 ? `${Math.floor(eta / 60)}m ${Math.round(eta % 60)}s`
        : `${Math.floor(eta / 3600)}h ${Math.floor((eta % 3600) / 60)}m`
    : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          <span className="font-mono text-sm uppercase text-zinc-300">copy</span>
          <span className="text-xs text-zinc-600">#{job.id}</span>
        </div>
        <div className="flex items-center gap-3">
          {fmtEta && job.status === "running" && (
            <span className="text-xs text-zinc-500">ETA: {fmtEta}</span>
          )}
          <Link
            href={`/jobs/${job.id}`}
            className="text-xs text-zinc-500 hover:text-white transition-colors"
          >
            Details →
          </Link>
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-green-600 transition-all"
            style={{ width: `${Math.min(100, progress * 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>
            {copiedFiles.toLocaleString()} / {totalFiles.toLocaleString()} files
            {" · "}
            {formatBytes(copiedBytes)} / {formatBytes(totalBytes)}
          </span>
          {bytesPerSec > 0 && <span>{formatBytes(Math.round(bytesPerSec))}/s</span>}
        </div>
        <div className="flex items-center justify-between text-xs text-zinc-600">
          <span>{pendingFiles.toLocaleString()} files remaining</span>
          <span>{formatBytes(remainingBytes)} remaining</span>
        </div>
      </div>

      {/* Current file */}
      {currentFile && job.status === "running" && (
        <div className="space-y-1.5">
          <p className="text-xs text-zinc-600 truncate font-mono">{currentFile}</p>
          {showCurrentFileProgress && (
            <>
              <div className="h-1 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-green-700 transition-all"
                  style={{
                    width: `${currentFileBytes > 0 ? Math.min(100, (currentFileBytesCopied / currentFileBytes) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="text-xs text-zinc-600 font-mono">
                Current file: {formatBytes(currentFileBytesCopied)} / {formatBytes(currentFileBytes)}
              </p>
            </>
          )}
        </div>
      )}

      {/* Error/skip summary */}
      {((p?.errorFiles ?? 0) > 0 || (p?.skippedFiles ?? 0) > 0) && (
        <div className="flex gap-3 text-xs">
          {(p?.skippedFiles ?? 0) > 0 && (
            <span className="text-yellow-500">{p!.skippedFiles} skipped</span>
          )}
          {(p?.errorFiles ?? 0) > 0 && (
            <span className="text-red-400">{p!.errorFiles} errors</span>
          )}
        </div>
      )}
    </div>
  );
}

function DiffProgressCard({
  job,
  fallback,
  now,
}: {
  job: Job | null;
  fallback: DiffJobSummary;
  now: number;
}) {
  const j = job ?? fallback;
  const items = "itemsProcessed" in j ? j.itemsProcessed : 0;
  const status = j.status;
  const startedAt = job?.startedAt ?? null;
  const elapsed = startedAt ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : null;

  const fmtElapsed = elapsed != null
    ? elapsed < 60
      ? `${elapsed}s`
      : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge status={status} />
          <span className="font-mono text-sm uppercase text-zinc-300">diff</span>
          <span className="text-xs text-zinc-600">#{fallback.id}</span>
        </div>
        {fmtElapsed && (
          <span className="text-xs text-zinc-500">{fmtElapsed}</span>
        )}
      </div>

      {/* Progress bar — indeterminate pulse when no total is known */}
      <div className="space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-600 transition-all animate-pulse"
            style={{ width: "100%" }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>{items.toLocaleString()} entries compared</span>
          <span className="capitalize">{status}</span>
        </div>
      </div>
    </div>
  );
}

// ── Duplicates tab ────────────────────────────────────────────────────────────

function DuplicatesTab({ diskId, disk }: { diskId: number; disk: Disk }) {
  const queryClient = useQueryClient();
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);
  const [selectedScanId, setSelectedScanId] = useState<number | null>(null);
  // jobId of the cleanup whose progress is being viewed in a modal. Null when
  // the user hasn't requested a progress view.
  const [viewingCleanupJobId, setViewingCleanupJobId] = useState<number | null>(null);

  // Poll for an in-flight directory cleanup job on this disk so we can surface
  // a "View progress" banner even after the user dismissed the confirm dialog.
  const { data: cleanupJobs = [] } = useQuery<Job[]>({
    queryKey: ["jobs", { diskId, type: "directory_duplicate_cleanup" }],
    queryFn: () => api.jobs.list({ type: "directory_duplicate_cleanup", targetDiskId: diskId, limit: 5 }),
    refetchInterval: (query) => {
      const jobs = (query.state.data ?? []) as Job[];
      const hasActive = jobs.some((j) => j.status === "running" || j.status === "queued" || j.status === "paused");
      return hasActive ? 2_000 : 10_000;
    },
  });
  const activeCleanup = cleanupJobs.find((j) =>
    j.status === "running" || j.status === "queued" || j.status === "paused"
  ) ?? null;

  const { data: scans = [] } = useQuery<DuplicateScanSummary[]>({
    queryKey: ["duplicateScans", diskId],
    queryFn: () => api.duplicates.scans(diskId),
  });

  const { data: duplicateJobs = [], refetch: refetchDuplicateJobs } = useQuery<DuplicateJobSummary[]>({
    queryKey: ["duplicateJobs", diskId],
    queryFn: () => api.duplicates.jobs(diskId),
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      const hasActive = jobs.some((j: DuplicateJobSummary) =>
        j.status === "running" || j.status === "queued" || j.status === "paused"
      );
      return hasActive || pendingJobId != null ? 2_000 : false;
    },
  });

  const effectiveSelectedScanId = selectedScanId ?? scans[0]?.id ?? null;
  const selectedScan = scans.find((scan) => scan.id === effectiveSelectedScanId) ?? null;
  const latestCompleted = duplicateJobs.find((j) =>
    j.status === "completed" && j.scanId === effectiveSelectedScanId
  ) ?? null;
  const activeJob = duplicateJobs.find((j) =>
    j.status === "running" || j.status === "queued" || j.status === "paused"
  ) ?? null;

  // Stop polling once the active job disappears
  if (pendingJobId && !activeJob) {
    setPendingJobId(null);
    refetchDuplicateJobs();
  }

  const startDetection = useMutation({
    mutationFn: () => api.duplicates.start(diskId, effectiveSelectedScanId != null ? { scanId: effectiveSelectedScanId } : undefined),
    onSuccess: (res) => {
      setPendingJobId(res.jobId);
      queryClient.invalidateQueries({ queryKey: ["duplicateJobs", diskId] });
      queryClient.invalidateQueries({ queryKey: ["duplicateScans", diskId] });
    },
    onError: (err: any) => alert(`Failed to start: ${err.message}`),
  });

  const canStart = !activeJob && effectiveSelectedScanId != null && !startDetection.isPending;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={effectiveSelectedScanId ?? ""}
          onChange={(e) => setSelectedScanId(e.target.value === "" ? null : Number(e.target.value))}
          disabled={scans.length === 0 || activeJob != null}
          className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500 disabled:opacity-40"
        >
          {scans.length === 0 ? (
            <option value="">No completed scans</option>
          ) : scans.map((scan) => (
            <option key={scan.id} value={scan.id}>
              Scan #{scan.id}{scan.hasAllFullHashes ? " · full hashes" : scan.hasAnyFullHashes ? " · partial full hashes" : " · sampled only"}
            </option>
          ))}
        </select>

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

      {selectedScan && !selectedScan.hasAllFullHashes && (
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
          Scan #{selectedScan.id} does not have full hashes for every file. Duplicate detection can still run, but cleanup will only be available for groups backed by full hashes. Choose an earlier full-hash scan if you want cleanup-ready results.
        </div>
      )}

      {activeCleanup && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-800/50 bg-blue-950/20 px-4 py-3 text-sm text-blue-300">
          <span>
            Directory cleanup #{activeCleanup.id} — {activeCleanup.status}…
          </span>
          <button
            onClick={() => setViewingCleanupJobId(activeCleanup.id)}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
          >
            View progress
          </button>
        </div>
      )}

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

      {viewingCleanupJobId != null && (
        <CleanupProgressDialogBody
          jobId={viewingCleanupJobId}
          onClose={() => setViewingCleanupJobId(null)}
        />
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
