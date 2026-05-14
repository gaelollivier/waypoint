import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

/** Insert a directory row and return its id. */
function insertDirectory(
  ctx: TestContext,
  diskId: number,
  id: number,
  name: string,
  path: string
): void {
  ctx.db
    .prepare(
      "INSERT INTO directories (id, disk_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, diskId, null, name, path, 0, 0, 0);
}

/** Insert a file row with a sampled hash. */
function insertFile(
  ctx: TestContext,
  diskId: number,
  directoryId: number,
  name: string,
  filePath: string
): void {
  ctx.db
    .prepare(
      "INSERT INTO files (disk_id, directory_id, name, path, size_bytes, mtime, sampled_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(diskId, directoryId, name, filePath, 100, "2024-01-01", "abc123", 1);
}

describe("diff routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ── POST /api/disks/:id/diff ────────────────────────────────────

  describe("POST /api/disks/:id/diff", () => {
    it("returns 400 when destDiskId is missing", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/diff`, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("destDiskId is required");
    });

    it("returns 404 when source disk does not exist", async () => {
      const destId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", "/api/disks/9999/diff", { destDiskId: destId });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Source disk not found");
    });

    it("returns 404 when destination disk does not exist", async () => {
      const sourceId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${sourceId}/diff`, { destDiskId: 9999 });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Destination disk not found");
    });

    it("returns 409 when source disk has no scan data", async () => {
      const sourceId = insertDisk(ctx.db);
      const destId = insertDisk(ctx.db);

      // Dest has a file, source does not
      insertDirectory(ctx, destId, 200, "DestRoot", "/mnt/dest");
      insertFile(ctx, destId, 200, "dest.txt", "/mnt/dest/dest.txt");

      const res = await req(ctx.app, "POST", `/api/disks/${sourceId}/diff`, { destDiskId: destId });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Source disk has no scan data");
    });

    it("returns 409 when destination disk has no scan data", async () => {
      const sourceId = insertDisk(ctx.db);
      const destId = insertDisk(ctx.db);

      // Source has a file, dest does not
      insertDirectory(ctx, sourceId, 100, "SourceRoot", "/mnt/source");
      insertFile(ctx, sourceId, 100, "test.txt", "/mnt/source/test.txt");

      const res = await req(ctx.app, "POST", `/api/disks/${sourceId}/diff`, { destDiskId: destId });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Destination disk has no scan data");
    });

    it("returns 202 with jobId when both disks have scan data", async () => {
      const sourceId = insertDisk(ctx.db);
      const destId = insertDisk(ctx.db);

      insertDirectory(ctx, sourceId, 100, "SourceRoot", "/mnt/source");
      insertFile(ctx, sourceId, 100, "test.txt", "/mnt/source/test.txt");

      insertDirectory(ctx, destId, 200, "DestRoot", "/mnt/dest");
      insertFile(ctx, destId, 200, "test.txt", "/mnt/dest/test.txt");

      const res = await req(ctx.app, "POST", `/api/disks/${sourceId}/diff`, { destDiskId: destId });
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("jobId");
      expect(typeof res.body.jobId).toBe("number");
    });

    it("returns 409 when a diff is already active for this pair", async () => {
      const sourceId = insertDisk(ctx.db);
      const destId = insertDisk(ctx.db);

      insertDirectory(ctx, sourceId, 100, "SourceRoot", "/mnt/source");
      insertFile(ctx, sourceId, 100, "test.txt", "/mnt/source/test.txt");

      insertDirectory(ctx, destId, 200, "DestRoot", "/mnt/dest");
      insertFile(ctx, destId, 200, "test.txt", "/mnt/dest/test.txt");

      // First diff
      const first = await req(ctx.app, "POST", `/api/disks/${sourceId}/diff`, { destDiskId: destId });
      expect(first.status).toBe(202);

      // Second diff on same pair
      const second = await req(ctx.app, "POST", `/api/disks/${sourceId}/diff`, { destDiskId: destId });
      expect(second.status).toBe(409);
      expect(second.body.error).toContain("already active");
    });
  });

  // ── GET /api/disks/:id/diff ─────────────────────────────────────

  describe("GET /api/disks/:id/diff", () => {
    it("returns 400 when destDiskId query param is missing", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/diff`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("destDiskId query param is required");
    });

    it("returns 404 when source disk does not exist", async () => {
      const res = await req(ctx.app, "GET", "/api/disks/9999/diff?destDiskId=1");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Source disk not found");
    });

    it("returns 404 when no completed diff exists for the pair", async () => {
      const sourceId = insertDisk(ctx.db);
      const destId = insertDisk(ctx.db);

      const res = await req(ctx.app, "GET", `/api/disks/${sourceId}/diff?destDiskId=${destId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No completed diff found");
    });

    it("returns diff tree when a completed diff job exists", async () => {
      const sourceId = insertDisk(ctx.db, { mount_path: "/mnt/source" });
      const destId = insertDisk(ctx.db, { mount_path: "/mnt/dest" });

      // Create a completed diff job
      const jobId = insertJob(ctx.db, {
        type: "diff",
        status: "completed",
      });
      // Set source_disk_id and dest_disk_id on the job
      ctx.db
        .prepare("UPDATE jobs SET source_disk_id = ?, dest_disk_id = ?, completed_at = datetime('now') WHERE id = ?")
        .run(sourceId, destId, jobId);

      // Insert a diff_dirs root row
      ctx.db
        .prepare(
          `INSERT INTO diff_dirs (id, diff_job_id, parent_id, path, added_count, added_bytes, changed_count, changed_bytes, removed_count, removed_bytes, present_count, present_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(1, jobId, null, "/", 2, 500, 0, 0, 1, 100, 3, 800);

      const res = await req(ctx.app, "GET", `/api/disks/${sourceId}/diff?destDiskId=${destId}`);
      expect(res.status).toBe(200);
      expect(res.body.diffJobId).toBe(jobId);
      expect(res.body.sourceDiskId).toBe(sourceId);
      expect(res.body.destDiskId).toBe(destId);
      expect(res.body.parentPath).toBe("/");
      expect(res.body.totalAdded).toBe(2);
      expect(res.body.totalAddedBytes).toBe(500);
      expect(res.body.totalRemoved).toBe(1);
      expect(res.body.totalPresent).toBe(3);
    });
  });

  // ── GET /api/disks/:id/diff/jobs ────────────────────────────────

  describe("GET /api/disks/:id/diff/jobs", () => {
    it("returns empty list when no diff jobs exist", async () => {
      const diskId = insertDisk(ctx.db);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/diff/jobs`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns diff jobs after creating some", async () => {
      const sourceId = insertDisk(ctx.db, { label: "Source" });
      const destId = insertDisk(ctx.db, { label: "Dest" });

      // Insert diff jobs directly using SQL (not via the route)
      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });
      ctx.db
        .prepare("UPDATE jobs SET source_disk_id = ?, dest_disk_id = ?, completed_at = datetime('now') WHERE id = ?")
        .run(sourceId, destId, jobId);

      const res = await req(ctx.app, "GET", `/api/disks/${sourceId}/diff/jobs`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(jobId);
      expect(res.body[0].status).toBe("completed");
      expect(res.body[0].sourceDiskId).toBe(sourceId);
      expect(res.body[0].destDiskId).toBe(destId);
      expect(res.body[0].destLabel).toBe("Dest");
    });

    it("does not return diff jobs for other source disks", async () => {
      const sourceA = insertDisk(ctx.db);
      const sourceB = insertDisk(ctx.db);
      const dest = insertDisk(ctx.db);

      const jobId = insertJob(ctx.db, { type: "diff", status: "completed" });
      ctx.db.prepare("UPDATE jobs SET source_disk_id = ?, dest_disk_id = ? WHERE id = ?").run(sourceA, dest, jobId);

      // Query diff jobs for sourceB -- should be empty
      const res = await req(ctx.app, "GET", `/api/disks/${sourceB}/diff/jobs`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
