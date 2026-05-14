import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db/client";
import { getJobManager, getRunner, registerRunner, unregisterRunner } from "../jobs";
import { sseRegistry } from "../jobs/sse";
import { ScanJobRunner } from "../jobs/scan/scan-job";
import { CopyJobRunner } from "../jobs/copy/copy-job";
import { WriteSpeedJobRunner } from "../jobs/write-speed/write-speed-job";
import { getDiskById } from "../disks/registry";

export const jobsRouter = new Hono();

// List jobs (optional ?status=, ?type=, ?targetDiskId=, ?limit= query params)
jobsRouter.get("/", (c) => {
  const status = c.req.query("status") as any;
  const type = c.req.query("type") as any;
  const targetDiskIdRaw = c.req.query("targetDiskId");
  const targetDiskId = targetDiskIdRaw ? Number(targetDiskIdRaw) : undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const jobs = getJobManager().listJobs({ status, type, targetDiskId, limit });
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

// Pause a running job. If no in-process runner exists (e.g. after a server
// restart orphaned the job), fall back to a DB-only transition so the job
// can be resumed later.
jobsRouter.post("/:id/pause", (c) => {
  const id = Number(c.req.param("id"));
  const jm = getJobManager();
  const job = jm.getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "running") {
    return c.json({ error: `Job is ${job.status}, not running` }, 409);
  }
  const runner = getRunner(id);
  if (runner) {
    runner.pause();
    return c.json({ ok: true });
  }
  // Orphaned running job (server restarted) — transition DB directly
  jm.transition(id, "paused");
  sseRegistry.publish(id, "status", { id, status: "paused" });
  return c.json({ ok: true, rehydrated: false });
});

// Resume a paused job. If no in-process runner exists (e.g. after a server
// restart), rehydrate one — `JobRunner.start()` accepts the paused→running
// transition and the scan walker resumes from its persisted walk queue.
jobsRouter.post("/:id/resume", (c) => {
  const id = Number(c.req.param("id"));
  const jm = getJobManager();
  const job = jm.getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "paused") {
    return c.json({ error: `Job is ${job.status}, not paused` }, 409);
  }

  const existing = getRunner(id);
  if (existing) {
    existing.resume();
    return c.json({ ok: true });
  }

  const db = getDb();

  // Rehydrate based on job type
  if (job.type === "scan") {
    if (job.target_disk_id == null) {
      return c.json({ error: "Scan job has no target disk" }, 500);
    }
    const disk = getDiskById(db, job.target_disk_id);
    if (!disk) return c.json({ error: "Target disk no longer exists" }, 410);
    if (!disk.is_connected || !disk.mount_path) {
      return c.json({ error: "Target disk is not connected" }, 409);
    }

    const runner = new ScanJobRunner({
      jobId: job.id,
      jobManager: jm,
      db,
      diskId: disk.id,
      mountPath: disk.mount_path,
    });

    registerRunner(job.id, runner);
    runner.start().finally(() => unregisterRunner(job.id));
    return c.json({ ok: true, rehydrated: true });
  }

  if (job.type === "copy") {
    if (job.source_disk_id == null || job.dest_disk_id == null) {
      return c.json({ error: "Copy job has no source or dest disk" }, 500);
    }
    const sourceDisk = getDiskById(db, job.source_disk_id);
    if (!sourceDisk) return c.json({ error: "Source disk no longer exists" }, 410);
    if (!sourceDisk.is_connected || !sourceDisk.mount_path) {
      return c.json({ error: "Source disk is not connected" }, 409);
    }
    const destDisk = getDiskById(db, job.dest_disk_id);
    if (!destDisk) return c.json({ error: "Dest disk no longer exists" }, 410);
    if (!destDisk.is_connected || !destDisk.mount_path) {
      return c.json({ error: "Dest disk is not connected" }, 409);
    }

    const payload = job.payload_json ? JSON.parse(job.payload_json) : {};
    if (!payload.diffJobId) {
      return c.json({ error: "Copy job payload missing diffJobId" }, 500);
    }

    const runner = new CopyJobRunner({
      jobId: job.id,
      jobManager: jm,
      db,
      sourceDiskId: job.source_disk_id,
      destDiskId: job.dest_disk_id,
      diffJobId: payload.diffJobId,
      destMountPath: destDisk.mount_path,
      sourceMountPath: sourceDisk.mount_path,
    });

    registerRunner(job.id, runner);
    runner.start().finally(() => unregisterRunner(job.id));
    return c.json({ ok: true, rehydrated: true });
  }

  if (job.type === "write_speed_test") {
    if (job.target_disk_id == null) {
      return c.json({ error: "Write speed test has no target disk" }, 500);
    }
    const disk = getDiskById(db, job.target_disk_id);
    if (!disk) return c.json({ error: "Target disk no longer exists" }, 410);
    if (!disk.is_connected || !disk.mount_path) {
      return c.json({ error: "Target disk is not connected" }, 409);
    }

    const payload = job.payload_json ? JSON.parse(job.payload_json) : {};
    if (!payload.sizeBytes || !payload.mode || !payload.fileUuid) {
      return c.json({ error: "Write speed test payload is incomplete" }, 500);
    }

    const runner = new WriteSpeedJobRunner({
      jobId: job.id,
      jobManager: jm,
      diskId: job.target_disk_id,
      mountPath: disk.mount_path,
      totalBytes: payload.sizeBytes,
      mode: payload.mode,
      fileUuid: payload.fileUuid,
    });

    registerRunner(job.id, runner);
    runner.start().finally(() => unregisterRunner(job.id));
    return c.json({ ok: true, rehydrated: true });
  }

  return c.json({ error: `Cannot rehydrate ${job.type} jobs yet` }, 501);
});

// Cancel a job. If an in-process runner exists, signal it (so it cleans up).
// Otherwise (paused job that survived a restart) just transition the DB row.
jobsRouter.post("/:id/cancel", (c) => {
  const id = Number(c.req.param("id"));
  const jm = getJobManager();
  const job = jm.getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return c.json({ error: `Job is already ${job.status}` }, 409);
  }

  const runner = getRunner(id);
  if (runner) {
    runner.cancel();
  } else {
    // Detached paused/queued job — only the DB row exists.
    jm.transition(id, "cancelled");
    sseRegistry.publish(id, "status", { id, status: "cancelled" });
  }
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
