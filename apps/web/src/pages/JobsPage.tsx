import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";
import { Link } from "../components/Router";
import { useLiveJob } from "../lib/useLiveJob";

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

function ActiveJobRow({ jobId }: { jobId: number }) {
  const queryClient = useQueryClient();
  const { job } = useLiveJob(jobId);
  if (!job) return null;

  const progress = (job.progressJson as any)?.progress ?? null;

  const handlePause = async (e: React.MouseEvent) => {
    e.preventDefault();
    await api.jobs.pause(job.id).catch(() => null);
    queryClient.invalidateQueries({ queryKey: ["job", job.id] });
  };
  const handleResume = async (e: React.MouseEvent) => {
    e.preventDefault();
    await api.jobs.resume(job.id).catch(() => null);
    queryClient.invalidateQueries({ queryKey: ["job", job.id] });
  };
  const handleCancel = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (confirm("Cancel this job?")) {
      await api.jobs.cancel(job.id).catch(() => null);
      queryClient.invalidateQueries({ queryKey: ["job", job.id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
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
            <button onClick={handlePause} className="text-xs text-zinc-400 hover:text-yellow-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800">Pause</button>
          )}
          {job.status === "paused" && (
            <button onClick={handleResume} className="text-xs text-zinc-400 hover:text-green-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800">Resume</button>
          )}
          <button onClick={handleCancel} className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800">Cancel</button>
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
      {job.status === "running" && <ProgressBar value={progress ?? 0} />}
    </Link>
  );
}

export function JobsPage() {
  const { data: jobs = [], isLoading } = useQuery<Job[]>({
    queryKey: ["jobs"],
    queryFn: () => api.jobs.list({ limit: 50 }),
    refetchInterval: 5_000,
  });

  const active = jobs.filter((j) => ["running", "paused", "queued"].includes(j.status));
  const recent = jobs.filter((j) => !["running", "paused", "queued"].includes(j.status));

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-lg font-semibold text-white">Jobs</h1>

      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {active.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Active</h2>
              {active.map((j) => <ActiveJobRow key={j.id} jobId={j.id} />)}
            </section>
          )}

          {recent.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Recent</h2>
              {recent.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 transition-colors">
                  <StatusBadge status={j.status} />
                  <span className="font-mono text-xs uppercase text-zinc-400 w-16">{j.type}</span>
                  <span className="text-xs text-zinc-600">#{j.id}</span>
                  <span className="flex-1 text-xs text-zinc-500 truncate">
                    {j.itemsProcessed.toLocaleString()} files · {formatBytes(j.bytesProcessed)}
                  </span>
                </Link>
              ))}
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
