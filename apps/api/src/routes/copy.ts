import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { CopyJobRunner } from "../jobs/copy/copy-job";

export const copyRouter = new Hono();

// ---------------------------------------------------------------------------
// POST /api/copy
// Start a copy job that copies files from source to dest based on a diff.
// Body: { sourceDiskId, destDiskId, diffJobId }
// ---------------------------------------------------------------------------
copyRouter.post("/", async (c) => {
  const body = await c.req.json<{
    sourceDiskId: number;
    destDiskId: number;
    diffJobId: number;
  }>();

  const { sourceDiskId, destDiskId, diffJobId } = body;

  if (!sourceDiskId || !destDiskId || !diffJobId) {
    return c.json({ error: "sourceDiskId, destDiskId, and diffJobId are required" }, 400);
  }

  if (sourceDiskId === destDiskId) {
    return c.json({ error: "Source and destination disk must be different" }, 400);
  }

  const db = getDb();

  // Validate disks exist and are connected
  const sourceDisk = getDiskById(db, sourceDiskId);
  if (!sourceDisk) return c.json({ error: "Source disk not found" }, 404);
  if (!sourceDisk.is_connected || !sourceDisk.mount_path) {
    return c.json({ error: "Source disk is not connected" }, 409);
  }

  const destDisk = getDiskById(db, destDiskId);
  if (!destDisk) return c.json({ error: "Destination disk not found" }, 404);
  if (!destDisk.is_connected || !destDisk.mount_path) {
    return c.json({ error: "Destination disk is not connected" }, 409);
  }

  // Validate diff job exists and is completed for this pair
  const jm = getJobManager();
  const diffJob = jm.getJob(diffJobId);
  if (!diffJob) return c.json({ error: "Diff job not found" }, 404);
  if (diffJob.type !== "diff") {
    return c.json({ error: "Referenced job is not a diff job" }, 400);
  }
  if (diffJob.status !== "completed") {
    return c.json({ error: "Diff job has not completed" }, 409);
  }
  if (diffJob.source_disk_id !== sourceDiskId || diffJob.dest_disk_id !== destDiskId) {
    return c.json({ error: "Diff job does not match the specified source/dest disks" }, 400);
  }

  // Check for existing active/paused copy job on this dest disk
  const activeCopy = db
    .prepare(
      `SELECT id FROM jobs
       WHERE type = 'copy'
         AND dest_disk_id = ?
         AND status IN ('queued', 'running', 'paused')
       LIMIT 1`
    )
    .get(destDiskId) as { id: number } | null;
  if (activeCopy) {
    return c.json(
      { error: `A copy job is already active on this dest disk (job ${activeCopy.id})` },
      409
    );
  }

  // Create the copy job
  const job = jm.createJob({
    type: "copy",
    sourceDiskId,
    destDiskId,
    payload: { diffJobId },
  });

  const runner = new CopyJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    sourceDiskId,
    destDiskId,
    diffJobId,
    destMountPath: destDisk.mount_path,
    sourceMountPath: sourceDisk.mount_path,
  });

  registerRunner(job.id, runner);
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});
