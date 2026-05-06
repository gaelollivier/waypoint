import { Hono } from "hono";
import { getDb } from "../db/client";
import { ensureDiskId } from "../disks/identity";
import { registerDisk, getAllDisks, getDiskById, updateDisk } from "../disks/registry";
import { getLockManager } from "../locks";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { ScanJobRunner } from "../jobs/scan/scan-job";


export const disksRouter = new Hono();

// List all registered disks
disksRouter.get("/", (c) => {
  const disks = getAllDisks(getDb());
  return c.json(disks.map(formatDisk));
});

// Register a disk at the given mount path.
// The user supplies the path; the server writes the dotfile and creates the DB row.
disksRouter.post("/", async (c) => {
  const body = await c.req.json<{
    mountPath: string;
    label: string;
    kind: "ssd" | "hdd";
    role: "source" | "destination";
  }>();

  if (!body.mountPath || !body.label || !body.kind || !body.role) {
    return c.json({ error: "mountPath, label, kind, role are required" }, 400);
  }
  if (!["ssd", "hdd"].includes(body.kind)) {
    return c.json({ error: "kind must be ssd or hdd" }, 400);
  }
  if (!["source", "destination"].includes(body.role)) {
    return c.json({ error: "role must be source or destination" }, 400);
  }

  let diskUuid: string;
  try {
    diskUuid = await ensureDiskId(body.mountPath);
  } catch (err: any) {
    const msg =
      err?.code === "EROFS"
        ? `${body.mountPath} is read-only — cannot write disk identity file`
        : err?.code === "ENOENT"
        ? `Path not found: ${body.mountPath}`
        : `Failed to write disk identity file: ${err?.message ?? err}`;
    return c.json({ error: msg }, 422);
  }

  const db = getDb();

  // Already registered?
  const existing = db.prepare("SELECT * FROM disks WHERE disk_uuid = ?").get(diskUuid);
  if (existing) {
    return c.json(
      { error: "This disk is already registered", disk: formatDisk(existing as any) },
      409
    );
  }

  const disk = registerDisk(db, {
    diskUuid,
    label: body.label,
    kind: body.kind,
    role: body.role,
    mountPath: body.mountPath,
    capacityBytes: null, // poller will fill this in on first cycle
    freeBytes: null,
  });

  return c.json(formatDisk(disk), 201);
});

// Update label / kind / role
disksRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "Invalid disk id" }, 400);
  }

  const body = await c.req.json<Partial<{ label: string; kind: string; role: string }>>();

  if (body.kind && !["ssd", "hdd"].includes(body.kind)) {
    return c.json({ error: "kind must be ssd or hdd" }, 400);
  }
  if (body.role && !["source", "destination"].includes(body.role)) {
    return c.json({ error: "role must be source or destination" }, 400);
  }

  const db = getDb();
  if (!getDiskById(db, id)) {
    return c.json({ error: "Disk not found" }, 404);
  }

  const updated = updateDisk(db, id, {
    label: body.label,
    kind: body.kind as "ssd" | "hdd" | undefined,
    role: body.role as "source" | "destination" | undefined,
  });

  return c.json(formatDisk(updated!));
});

// Start a scan job for a disk
disksRouter.post("/:id/scan", async (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, id);
  if (!disk) return c.json({ error: "Disk not found" }, 404);
  if (!disk.is_connected || !disk.mount_path) {
    return c.json({ error: "Disk is not connected" }, 409);
  }

  // Only one active/paused scan per disk at a time
  const activeScan = db
    .prepare(
      `SELECT id FROM jobs
       WHERE target_disk_id = ? AND type = 'scan'
         AND status IN ('queued', 'running', 'paused')
       LIMIT 1`
    )
    .get(id);
  if (activeScan) {
    return c.json({ error: "A scan is already active for this disk" }, 409);
  }

  const jm = getJobManager();
  const job = jm.createJob({ type: "scan", targetDiskId: id });

  const runner = new ScanJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    diskId: id,
    mountPath: disk.mount_path,
  });

  registerRunner(job.id, runner);

  // Fire and forget — client polls/streams via SSE
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});

// Lock state for a disk
disksRouter.get("/:id/lock", (c) => {
  const id = Number(c.req.param("id"));
  const state = getLockManager().getState(id);
  if (!state) return c.json({ diskId: id, locked: false });
  return c.json({
    diskId: id,
    locked: true,
    jobId: state.jobId,
    state: state.state,
    acquiredAt: state.acquiredAt.toISOString(),
    pausedAt: state.pausedAt?.toISOString() ?? null,
  });
});

function formatDisk(disk: any) {
  return {
    id: disk.id,
    diskUuid: disk.disk_uuid,
    label: disk.label,
    kind: disk.kind,
    role: disk.role,
    capacityBytes: disk.capacity_bytes,
    freeBytes: disk.free_bytes,
    mountPath: disk.mount_path,
    isConnected: Boolean(disk.is_connected),
    lastSeenAt: disk.last_seen_at,
    lastScanAt: disk.last_scan_at,
    lastBackupAt: disk.last_backup_at,
    lastVerifyAt: disk.last_verify_at,
  };
}
