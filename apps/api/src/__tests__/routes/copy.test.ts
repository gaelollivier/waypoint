import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

describe("copy routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ── POST /api/copy ──────────────────────────────────────────────

  describe("POST /api/copy", () => {
    it("returns 400 when required fields are missing", async () => {
      const res = await req(ctx.app, "POST", "/api/copy", {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });

    it("returns 400 when sourceDiskId equals destDiskId", async () => {
      const diskId = insertDisk(ctx.db, { mount_path: "/tmp/disk", is_connected: 1 });
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: diskId,
        destDiskId: diskId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("different");
    });

    it("returns 404 when source disk does not exist", async () => {
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/dest", is_connected: 1 });
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: 9999,
        destDiskId: destId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Source disk not found");
    });

    it("returns 404 when destination disk does not exist", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/source", is_connected: 1 });
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: 9999,
        diffJobId: jobId,
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Destination disk not found");
    });

    it("returns 409 when source disk is not connected", async () => {
      const sourceId = insertDisk(ctx.db, { is_connected: 0 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/dest", is_connected: 1 });
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Source disk is not connected");
    });

    it("returns 409 when destination disk is not connected", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { is_connected: 0 });
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Destination disk is not connected");
    });

    it("returns 404 when diff job does not exist", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/dest", is_connected: 1 });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId: 9999,
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Diff job not found");
    });

    it("returns 400 when referenced job is not a diff job", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/dest", is_connected: 1 });
      // Create a scan job, not a diff
      const jobId = insertJob(ctx.db, { type: "scan", status: "completed" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Referenced job is not a diff job");
    });

    it("returns 409 when diff job has not completed", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/dest", is_connected: 1 });
      const jobId = insertJob(ctx.db, { type: "diff", status: "running" });

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Diff job has not completed");
    });

    it("returns 400 when diff job does not match source/dest disks", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/dest", is_connected: 1 });
      const otherId = insertDisk(ctx.db, { mount_path: "/tmp/other", is_connected: 1 });

      // Create a completed diff job that points to different disks
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });
      ctx.db
        .prepare("UPDATE jobs SET source_disk_id = ?, dest_disk_id = ?, completed_at = datetime('now') WHERE id = ?")
        .run(sourceId, otherId, jobId);

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId: jobId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("does not match");
    });

    it("returns 202 with jobId for a valid copy request", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/test-source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/test-dest", is_connected: 1 });

      // Create a completed diff job linking the two disks
      const diffJobId = insertJob(ctx.db, { type: "diff", status: "completed" });
      ctx.db
        .prepare("UPDATE jobs SET source_disk_id = ?, dest_disk_id = ?, completed_at = datetime('now') WHERE id = ?")
        .run(sourceId, destId, diffJobId);

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId,
      });
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("jobId");
      expect(typeof res.body.jobId).toBe("number");
      // The jobId should be different from the diffJobId
      expect(res.body.jobId).not.toBe(diffJobId);
    });

    it("returns 409 when a copy job is already active on the dest disk", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/tmp/test-source", is_connected: 1 });
      const destId = insertDisk(ctx.db, { mount_path: "/tmp/test-dest", is_connected: 1 });

      // Insert an active copy job on destId directly to simulate one in progress
      const activeCopyJobId = insertJob(ctx.db, { type: "copy", status: "running" });
      ctx.db
        .prepare("UPDATE jobs SET dest_disk_id = ? WHERE id = ?")
        .run(destId, activeCopyJobId);

      const diffJobId = insertJob(ctx.db, { type: "diff", status: "completed" });
      ctx.db
        .prepare("UPDATE jobs SET source_disk_id = ?, dest_disk_id = ?, completed_at = datetime('now') WHERE id = ?")
        .run(sourceId, destId, diffJobId);

      const res = await req(ctx.app, "POST", "/api/copy", {
        sourceDiskId: sourceId,
        destDiskId: destId,
        diffJobId,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already active");
    });
  });
});
