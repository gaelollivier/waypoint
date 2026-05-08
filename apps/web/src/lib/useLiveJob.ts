import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import type { Job, JobEvent } from "../api/types";

const ACTIVE_STATUSES = ["queued", "running", "paused"] as const;
function isActive(status: Job["status"]): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

const EVENTS_POLL_INTERVAL_MS = 2000;

/**
 * Subscribes to a job: initial fetch + SSE updates while active. Optionally
 * also polls the events log. Returns the latest job, events, and a 1Hz `now`
 * timestamp for elapsed/ETA recomputation.
 *
 * Events polling is self-scheduling (one in-flight at a time, with abort on
 * unmount) — never piles up requests if the server is slow.
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
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  // Initial fetch
  useEffect(() => {
    if (jobId == null) { setJob(null); setEvents([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    const fetches: Promise<unknown>[] = [api.jobs.get(jobId).then((j) => { if (!cancelled) setJob(j); })];
    if (opts.events) {
      fetches.push(api.jobs.events(jobId).then((e) => { if (!cancelled) setEvents(e); }));
    }
    Promise.all(fetches).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [jobId, opts.events]);

  // SSE while active
  useEffect(() => {
    if (jobId == null || !job || !isActive(job.status)) return;
    const stop = api.jobs.stream(jobId, (event, data) => {
      if (event === "snapshot" || event === "status" || event === "progress") {
        setJob(data as Job);
      }
    });
    return stop;
  }, [jobId, job?.status]);

  // Self-scheduling events poll. One request in-flight at a time, aborted on
  // unmount. After each fetch completes (success OR failure), schedule the
  // next one with EVENTS_POLL_INTERVAL_MS delay.
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
        // Aborted or network error — ignore; next tick will retry.
      } finally {
        pollAbortRef.current = null;
        if (!stopped) {
          timer = setTimeout(tick, EVENTS_POLL_INTERVAL_MS);
        }
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

  return { job, events, now, loading };
}
