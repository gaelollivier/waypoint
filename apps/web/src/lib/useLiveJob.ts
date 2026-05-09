import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job, JobEvent } from "../api/types";

const ACTIVE_STATUSES = ["queued", "running", "paused"] as const;
function isActive(status: Job["status"]): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

const EVENTS_POLL_INTERVAL_MS = 2000;

/**
 * Subscribes to a job: React Query for the initial fetch + cache, SSE to keep
 * it live while active. Optionally polls the events log.
 *
 * The job is stored in the React Query cache under ['job', jobId] — other
 * components can read it via useQuery without re-fetching.
 */
export function useLiveJob(
  jobId: number | null,
  opts: { events?: boolean } = {}
): {
  job: Job | null;
  events: JobEvent[];
  now: number;
  loading: boolean;
} {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [now, setNow] = useState(Date.now());

  const { data: job = null, isLoading } = useQuery<Job | null>({
    queryKey: ["job", jobId],
    queryFn: () => (jobId != null ? api.jobs.get(jobId) : null),
    enabled: jobId != null,
    staleTime: 10_000,
  });

  // Initial events fetch
  useEffect(() => {
    if (jobId == null || !opts.events) return;
    let cancelled = false;
    api.jobs.events(jobId).then((e) => { if (!cancelled) setEvents(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, [jobId, opts.events]);

  // SSE while active — pumps updates into React Query cache
  useEffect(() => {
    if (jobId == null || !job || !isActive(job.status)) return;
    const stop = api.jobs.stream(jobId, (event, data) => {
      if (event === "snapshot" || event === "status" || event === "progress") {
        queryClient.setQueryData(["job", jobId], data as Job);
      }
    });
    return stop;
  }, [jobId, job?.status, queryClient]);

  // Self-scheduling events poll
  const pollAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (jobId == null || !opts.events || !job || !isActive(job.status)) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      const ac = new AbortController();
      pollAbortRef.current = ac;
      try {
        const evts = await api.jobs.events(jobId);
        if (!stopped) setEvents(evts);
      } catch {
        // ignore
      } finally {
        pollAbortRef.current = null;
        if (!stopped) timer = setTimeout(tick, EVENTS_POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, EVENTS_POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
    };
  }, [jobId, job?.status, opts.events]);

  // 1Hz tick for elapsed/ETA
  useEffect(() => {
    if (!job || !isActive(job.status)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job?.status]);

  return { job, events, now, loading: isLoading };
}
