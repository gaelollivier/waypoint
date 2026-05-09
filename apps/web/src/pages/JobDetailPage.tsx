import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Disk, JobEvent } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { JobDetails } from "../components/JobDetails";
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
  const queryClient = useQueryClient();
  const { job, events, now, loading } = useLiveJob(jobId, { events: true });
  const [disk, setDisk] = useState<Disk | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const eventsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const diskId = job?.targetDiskId ?? job?.sourceDiskId ?? null;
    if (diskId == null) return;
    let cancelled = false;
    api.disks.get(diskId).then((d) => { if (!cancelled) setDisk(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [job?.targetDiskId, job?.sourceDiskId]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (loading) return <p className="text-sm text-zinc-500 p-6">Loading…</p>;
  if (!job) return <p className="text-sm text-red-400 p-6">Job not found.</p>;

  let elapsedSec = 0;
  if (job.startedAt) {
    const start = new Date(job.startedAt).getTime();
    const end =
      job.completedAt ? new Date(job.completedAt).getTime()
      : job.status === "paused" && job.updatedAt ? new Date(job.updatedAt).getTime()
      : now;
    elapsedSec = Math.max(0, (end - start) / 1000);
  }

  const handlePause = async () => {
    await api.jobs.pause(jobId);
    queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  };
  const handleResume = async () => {
    await api.jobs.resume(jobId);
    queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  };
  const handleCancel = async () => {
    if (!confirm("Cancel?")) return;
    await api.jobs.cancel(jobId);
    queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    navigate("/jobs");
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
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
        <JobDetails
          job={job}
          now={now}
          disk={disk}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
        />
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
