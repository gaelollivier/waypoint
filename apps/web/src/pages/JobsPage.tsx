import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import type { Job } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";
import { Link } from "../components/Router";

function formatBytes(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + " TB";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "";
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function JobRow({ job: initial }: { job: Job }) {
  const [job, setJob] = useState(initial);

  // Stream live updates for active jobs
  useEffect(() => {
    if (!["running", "paused", "queued"].includes(initial.status)) return;
    return api.jobs.stream(initial.id, (_, data) => setJob(data as Job));
  }, [initial.id, initial.status]);

  const isActive = ["running", "paused", "queued"].includes(job.status);
  const progress = (job.progressJson as any)?.progress ?? null;

  const handlePause = async (e: React.MouseEvent) => {
    e.preventDefault();
    await api.jobs.pause(job.id).catch(() => null);
  };
  const handleResume = async (e: React.MouseEvent) => {
    e.preventDefault();
    await api.jobs.resume(job.id).catch(() => null);
  };
  const handleCancel = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (confirm("Cancel this job?")) await api.jobs.cancel(job.id).catch(() => null);
  };

  return (
    <Link href={`/jobs/${job.id}`} className="block rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 transition-colors p-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          <span className="text-sm font-mono text-zinc-300 uppercase">{job.type}</span>
          <span className="text-xs text-zinc-600">#{job.id}</span>
        </div>
        <div className="flex items-center gap-2">
          {job.status === "running" && (
            <button onClick={handlePause} className="text-xs text-zinc-400 hover:text-yellow-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800">
              Pause
            </button>
          )}
          {job.status === "paused" && (
            <button onClick={handleResume} className="text-xs text-zinc-400 hover:text-green-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800">
              Resume
            </button>
          )}
          {isActive && (
            <button onClick={handleCancel} className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800">
              Cancel
            </button>
          )}
          {job.startedAt && (
            <span className="text-xs text-zinc-600">{elapsed(job.startedAt)}</span>
          )}
        </div>
      </div>

      <div className="flex gap-6 text-xs text-zinc-500">
        <span>{job.itemsProcessed.toLocaleString()} files</span>
        <span>{formatBytes(job.bytesProcessed)}</span>
        {job.warningsCount > 0 && <span className="text-yellow-600">{job.warningsCount} warnings</span>}
        {job.errorsCount > 0 && <span className="text-red-500">{job.errorsCount} errors</span>}
      </div>

      {job.status === "running" && (
        <ProgressBar value={progress ?? 0} />
      )}
    </Link>
  );
}

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setJobs(await api.jobs.list({ limit: 50 }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const active = jobs.filter((j) => ["running", "paused", "queued"].includes(j.status));
  const recent = jobs.filter((j) => !["running", "paused", "queued"].includes(j.status));

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Jobs</h1>
        <button onClick={load} className="text-xs text-zinc-500 hover:text-white transition-colors">
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {active.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Active</h2>
              {active.map((j) => <JobRow key={j.id} job={j} />)}
            </section>
          )}

          {recent.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Recent</h2>
              {recent.map((j) => <JobRow key={j.id} job={j} />)}
            </section>
          )}

          {jobs.length === 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
              <p className="text-sm text-zinc-500">No jobs yet. Trigger a scan from the Disks page.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
