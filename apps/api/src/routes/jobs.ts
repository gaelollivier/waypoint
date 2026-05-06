import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getJobManager, getRunner } from "../jobs";
import { sseRegistry } from "../jobs/sse";

export const jobsRouter = new Hono();

// List jobs (optional ?status=, ?type=, ?limit= query params)
jobsRouter.get("/", (c) => {
  const status = c.req.query("status") as any;
  const type = c.req.query("type") as any;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const jobs = getJobManager().listJobs({ status, type, limit });
  return c.json(jobs.map(formatJob));
});

// Get a single job
jobsRouter.get("/:id", (c) => {
  const id = Number(c.req.param("id"));
  const job = getJobManager().getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(formatJob(job));
});

// Get job events log
jobsRouter.get("/:id/events-log", (c) => {
  const id = Number(c.req.param("id"));
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 200;
  if (!getJobManager().getJob(id)) return c.json({ error: "Job not found" }, 404);
  return c.json(getJobManager().getEvents(id, limit));
});

// SSE stream of live progress + status events
jobsRouter.get("/:id/events", (c) => {
  const id = Number(c.req.param("id"));
  const job = getJobManager().getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);

  return streamSSE(c, async (stream) => {
    // Send a snapshot of current state immediately on connect
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify(formatJob(job)),
    });

    // Buffer incoming events and drain them in the write loop
    const queue: Array<{ event: string; data: string }> = [];
    let notify: (() => void) | null = null;

    const unsub = sseRegistry.subscribe(id, ({ event, data }) => {
      queue.push({ event, data: JSON.stringify(data) });
      notify?.();
    });

    try {
      while (true) {
        if (queue.length > 0) {
          const msg = queue.shift()!;
          await stream.writeSSE(msg);
        } else {
          // Wait for the next event (or client disconnect, which throws)
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
      }
    } finally {
      unsub();
    }
  });
});

// Pause a running job
jobsRouter.post("/:id/pause", (c) => {
  const id = Number(c.req.param("id"));
  const job = getJobManager().getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "running") {
    return c.json({ error: `Job is ${job.status}, not running` }, 409);
  }
  const runner = getRunner(id);
  if (!runner) return c.json({ error: "Job is not active in this process" }, 409);
  runner.pause();
  return c.json({ ok: true });
});

// Resume a paused job
jobsRouter.post("/:id/resume", (c) => {
  const id = Number(c.req.param("id"));
  const job = getJobManager().getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "paused") {
    return c.json({ error: `Job is ${job.status}, not paused` }, 409);
  }
  const runner = getRunner(id);
  if (!runner) return c.json({ error: "Job is not active in this process" }, 409);
  runner.resume();
  return c.json({ ok: true });
});

// Cancel a job
jobsRouter.post("/:id/cancel", (c) => {
  const id = Number(c.req.param("id"));
  const job = getJobManager().getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return c.json({ error: `Job is already ${job.status}` }, 409);
  }
  const runner = getRunner(id);
  if (!runner) return c.json({ error: "Job is not active in this process" }, 409);
  runner.cancel();
  return c.json({ ok: true });
});

function formatJob(job: ReturnType<typeof getJobManager>["getJob"] extends (id: number) => infer R ? NonNullable<R> : never) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    phase: job.phase,
    parentJobId: job.parent_job_id,
    targetDiskId: job.target_disk_id,
    sourceDiskId: job.source_disk_id,
    destDiskId: job.dest_disk_id,
    bytesProcessed: job.bytes_processed,
    itemsProcessed: job.items_processed,
    warningsCount: job.warnings_count,
    nonCriticalErrorsCount: job.non_critical_errors_count,
    errorsCount: job.errors_count,
    progressJson: job.progress_json ? JSON.parse(job.progress_json) : null,
    createdBy: job.created_by,
    createdAt: job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
  };
}
