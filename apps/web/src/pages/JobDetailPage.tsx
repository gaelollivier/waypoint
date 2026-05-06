import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import type { Job, JobEvent } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";
import { navigate } from "../components/Router";

function formatBytes(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function elapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "—";
  const end = completedAt ? new Date(completedAt) : new Date();
  const secs = Math.floor((end.getTime() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const LEVEL_COLORS: Record<JobEvent["level"], string> = {
  info:    "text-zinc-500",
  warning: "text-yellow-500",
  error:   "text-red-500",
};

type Tab = "overview" | "events";

export function JobDetailPage({ id }: { id: string }) {
  const jobId = Number(id);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([api.jobs.get(jobId), api.jobs.events(jobId)]).then(([j, evts]) => {
      if (cancelled) return;
      setJob(j);
      setEvents(evts);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [jobId]);

  // SSE stream for live jobs
  useEffect(() => {
    if (!job) return;
    if (!["running", "paused", "queued"].includes(job.status)) return;

    const stop = api.jobs.stream(jobId, (event, data) => {
      if (event === "status" || event === "snapshot" || event === "progress") {
        setJob(data as Job);
      }
    });

    // Poll events log while active (SSE doesn't push events, only progress)
    const evtInterval = setInterval(async () => {
      const evts = await api.jobs.events(jobId).catch(() => null);
      if (evts) setEvents(evts);
    }, 2000);

    return () => { stop(); clearInterval(evtInterval); };
  }, [jobId, job?.status]);

  // Auto-scroll events log
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (loading) return <p className="text-sm text-zinc-500 p-6">Loading…</p>;
  if (!job) return <p className="text-sm text-red-400 p-6">Job not found.</p>;

  const progress = (job.progressJson as any)?.progress ?? null;
  const isActive = ["running", "paused", "queued"].includes(job.status);

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
            Duration {elapsed(job.startedAt, job.completedAt)}
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

      {/* Progress bar */}
      {(job.status === "running" || progress !== null) && (
        <ProgressBar value={progress ?? 0} />
      )}

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

      {/* Overview tab */}
      {tab === "overview" && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: "Files", value: job.itemsProcessed.toLocaleString() },
            { label: "Data", value: formatBytes(job.bytesProcessed) },
            { label: "Warnings", value: job.warningsCount.toString() },
            { label: "Errors", value: job.errorsCount.toString() },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-1">
              <p className="text-xs text-zinc-500">{label}</p>
              <p className="text-xl font-mono font-semibold text-white">{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Events tab */}
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
