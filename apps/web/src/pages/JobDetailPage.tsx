import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import type { Disk, JobEvent } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { JobProgressPanel } from "../components/JobProgressPanel";
import { navigate } from "../components/Router";
import { useLiveJob } from "../lib/useLiveJob";
import { formatDuration } from "../lib/format";

const LEVEL_COLORS: Record<JobEvent["level"], string> = {
  info:    "text-zinc-500",
  warning: "text-yellow-500",
  error:   "text-red-500",
};

type Tab = "overview" | "events";

export function JobDetailPage({ id }: { id: string }) {
  const jobId = Number(id);
  const { job, events, now, loading } = useLiveJob(jobId, { events: true });
  const [disk, setDisk] = useState<Disk | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // Fetch disk metadata (used for ETA against disk used-bytes total)
  useEffect(() => {
    const diskId = job?.targetDiskId ?? job?.sourceDiskId ?? null;
    if (diskId == null) return;
    let cancelled = false;
    api.disks.get(diskId).then((d) => { if (!cancelled) setDisk(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [job?.targetDiskId, job?.sourceDiskId]);

  // Auto-scroll events log
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (loading) return <p className="text-sm text-zinc-500 p-6">Loading…</p>;
  if (!job) return <p className="text-sm text-red-400 p-6">Job not found.</p>;

  const isActive = ["running", "paused", "queued"].includes(job.status);

  // Header elapsed (recomputed via 1Hz `now` from the hook)
  let elapsedSec = 0;
  if (job.startedAt) {
    const start = new Date(job.startedAt).getTime();
    const end =
      job.completedAt ? new Date(job.completedAt).getTime()
      : job.status === "paused" && job.updatedAt ? new Date(job.updatedAt).getTime()
      : now;
    elapsedSec = Math.max(0, (end - start) / 1000);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <StatusBadge status={job.status} />
            <span className="font-mono text-sm uppercase text-zinc-300">{job.type}</span>
            <span className="text-xs text-zinc-600">#{job.id}</span>
          </div>
          <p className="text-xs text-zinc-600">
            Started {job.startedAt ? new Date(job.startedAt).toLocaleString() : "not yet"} ·{" "}
            Duration {formatDuration(elapsedSec)}
          </p>
        </div>
        <div className="flex gap-2">
          {job.status === "running" && (
            <button
              onClick={() => api.jobs.pause(jobId)}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-yellow-400 hover:bg-zinc-700 transition-colors"
            >
              Pause
            </button>
          )}
          {job.status === "paused" && (
            <button
              onClick={() => api.jobs.resume(jobId)}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-green-400 hover:bg-zinc-700 transition-colors"
            >
              Resume
            </button>
          )}
          {isActive && (
            <button
              onClick={async () => { if (confirm("Cancel?")) { await api.jobs.cancel(jobId); navigate("/jobs"); } }}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {(["overview", "events"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-blue-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t === "events" ? `Events (${events.length})` : "Overview"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <JobProgressPanel job={job} now={now} disk={disk} />
      )}

      {tab === "events" && (
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
      )}
    </div>
  );
}
