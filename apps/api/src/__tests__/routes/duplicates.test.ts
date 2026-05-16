import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { computeFullHashStreaming, computeSampledHash } from "../../jobs/scan/hasher";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

/** Creates a scan job for a disk and sets last_scan_job_id. Returns the scan job id. */
function setupScan(ctx: TestContext, diskId: number): number {
  const scanId = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
  ctx.db.prepare("UPDATE disks SET last_scan_job_id = ? WHERE id = ?").run(scanId, diskId);
  return scanId;
}

/** Insert a root directory for a disk. */
function insertDirectory(
  ctx: TestContext,
  diskId: number,
  scanId: number,
  id: number,
  name: string,
  path: string
): void {
  ctx.db
    .prepare(
      "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, diskId, scanId, null, name, path, 0, 0, 0);
}

/** Insert a file row without a sampled hash. */
function insertFileNoHash(
  ctx: TestContext,
  diskId: number,
  scanId: number,
  directoryId: number,
  name: string,
  filePath: string
): void {
  ctx.db
    .prepare(
      "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(diskId, scanId, directoryId, name, filePath, 100, "2024-01-01", 1);
}

/** Insert a file row with a sampled hash. */
function insertFileWithHash(
  ctx: TestContext,
  diskId: number,
  scanId: number,
  directoryId: number,
  name: string,
  filePath: string,
  hash = "abc123"
): void {
  ctx.db
    .prepare(
      "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(diskId, scanId, directoryId, name, filePath, 100, "2024-01-01", hash, 1);
}

function insertFileWithFullHash(
  ctx: TestContext,
  diskId: number,
  scanId: number,
  directoryId: number,
  name: string,
  filePath: string,
  sampledHash: string,
  fullHash: string
): void {
  ctx.db
    .prepare(
      "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(diskId, scanId, directoryId, name, filePath, 100, "2024-01-01", sampledHash, fullHash, 1);
}

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "waypoint-duplicates-route-"));
  roots.push(root);
  return root;
}

describe("duplicates routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── POST /api/disks/:id/duplicates ──────────────────────────────

  describe("POST /api/disks/:id/duplicates", () => {
    it("returns 404 when disk does not exist", async () => {
      const res = await req(ctx.app, "POST", "/api/disks/9999/duplicates");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });

    it("returns 409 when disk has no scan data", async () => {
      const diskId = insertDisk(ctx.db);

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("no scan data");
    });

    it("returns 409 when disk has files but no hashed files", async () => {
      const diskId = insertDisk(ctx.db);
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", "/mnt/disk");
      insertFileNoHash(ctx, diskId, scanId, 100, "test.txt", "/mnt/disk/test.txt");

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("No hashed files found");
    });

    it("returns 202 with jobId when disk has hashed files", async () => {
      const diskId = insertDisk(ctx.db);
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", "/mnt/disk");
      insertFileWithHash(ctx, diskId, scanId, 100, "test.txt", "/mnt/disk/test.txt");

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("jobId");
      expect(typeof res.body.jobId).toBe("number");
    });

    it("returns 409 when a duplicate detection job is already active", async () => {
      const diskId = insertDisk(ctx.db);
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", "/mnt/disk");
      insertFileWithHash(ctx, diskId, scanId, 100, "test.txt", "/mnt/disk/test.txt");

      // Insert an active duplicate_detection job directly to simulate one in progress
      insertJob(ctx.db, { type: "duplicate_detection", status: "running", target_disk_id: diskId });

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already active");
    });
  });

  // ── GET /api/disks/:id/duplicates ───────────────────────────────

  describe("GET /api/disks/:id/duplicates", () => {
    it("returns 404 when no completed duplicate detection job exists", async () => {
      const diskId = insertDisk(ctx.db);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No completed duplicate detection job found");
    });

    it("returns results when a completed job with duplicate groups exists", async () => {
      const diskId = insertDisk(ctx.db);
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", "/mnt/disk");

      // Create real file rows so FK constraints are satisfied
      insertFileWithHash(ctx, diskId, scanId, 100, "a.txt", "/mnt/disk/a.txt", "hash1");
      insertFileWithHash(ctx, diskId, scanId, 100, "b.txt", "/mnt/disk/b.txt", "hash1");
      insertFileWithHash(ctx, diskId, scanId, 100, "c.txt", "/mnt/disk/c.txt", "hash1");

      // Get the file ids
      const fileRows = ctx.db
        .prepare("SELECT id, path FROM files WHERE scan_id = ? ORDER BY path")
        .all(scanId) as Array<{ id: number; path: string }>;

      // Create a completed duplicate_detection job
      const jobId = insertJob(ctx.db, { type: "duplicate_detection", status: "completed", target_disk_id: diskId });

      // Insert a duplicate group
      ctx.db
        .prepare(
          "INSERT INTO duplicate_groups (id, duplicate_job_id, sampled_hash, file_count, size_bytes, wasted_bytes) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(1, jobId, "hash1", 3, 1000, 2000);

      // Insert group files referencing real file ids
      for (const f of fileRows) {
        ctx.db
          .prepare("INSERT INTO duplicate_group_files (group_id, file_id, path) VALUES (?, ?, ?)")
          .run(1, f.id, f.path);
      }

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(200);
      expect(res.body.duplicateJobId).toBe(jobId);
      expect(res.body.diskId).toBe(diskId);
      expect(res.body.totalGroups).toBe(1);
      expect(res.body.totalWastedBytes).toBe(2000);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].sampledHash).toBe("hash1");
      expect(res.body.groups[0].fileCount).toBe(3);
      expect(res.body.groups[0].files).toHaveLength(3);
    });

    it("returns empty groups when job completed but found no duplicates", async () => {
      const diskId = insertDisk(ctx.db);

      insertJob(ctx.db, { type: "duplicate_detection", status: "completed", target_disk_id: diskId });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates`);
      expect(res.status).toBe(200);
      expect(res.body.totalGroups).toBe(0);
      expect(res.body.groups).toEqual([]);
    });
  });

  // ── GET /api/disks/:id/duplicates/scans ────────────────────────

  describe("GET /api/disks/:id/duplicates/scans", () => {
    it("reports full-hash coverage for selectable scans", async () => {
      const diskId = insertDisk(ctx.db);
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", "/mnt/disk");
      insertFileWithFullHash(ctx, diskId, scanId, 100, "a.txt", "/mnt/disk/a.txt", "sample-a", "full-a");
      insertFileWithHash(ctx, diskId, scanId, 100, "b.txt", "/mnt/disk/b.txt", "sample-b");

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/scans`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(scanId);
      expect(res.body[0].hasAnyFullHashes).toBe(true);
      expect(res.body[0].hasAllFullHashes).toBe(false);
    });
  });

  // ── POST /api/disks/:id/duplicates/cleanup ──────────────────────

  describe("POST /api/disks/:id/duplicates/cleanup", () => {
    async function setupFullHashCleanupGroup() {
      const root = makeRoot();
      const keepPath = path.join(root, "keep.txt");
      const deletePath = path.join(root, "delete.txt");
      writeFileSync(keepPath, "identical content");
      writeFileSync(deletePath, "identical content");

      const diskId = insertDisk(ctx.db, { mount_path: root, is_connected: 1 });
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", root);

      const sampledHash = await computeSampledHash(keepPath, 17);
      const fullHash = await computeFullHashStreaming(keepPath);
      insertFileWithFullHash(ctx, diskId, scanId, 100, "keep.txt", keepPath, sampledHash, fullHash);
      insertFileWithFullHash(ctx, diskId, scanId, 100, "delete.txt", deletePath, sampledHash, fullHash);

      const files = ctx.db
        .prepare("SELECT id, path FROM files WHERE scan_id = ? ORDER BY path")
        .all(scanId) as Array<{ id: number; path: string }>;
      const jobId = insertJob(ctx.db, { type: "duplicate_detection", status: "completed", target_disk_id: diskId });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);
      ctx.db.prepare(
        "INSERT INTO duplicate_groups (id, duplicate_job_id, hash_kind, content_hash, sampled_hash, file_count, size_bytes, wasted_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "full", fullHash, sampledHash, 2, 17, 17);
      for (const file of files) {
        ctx.db.prepare("INSERT INTO duplicate_group_files (group_id, file_id, path) VALUES (?, ?, ?)")
          .run(1, file.id, file.path);
      }
      return { diskId, keepFile: files.find((f) => f.path === keepPath)!, deleteFile: files.find((f) => f.path === deletePath)! };
    }

    it("deletes when selected-scan full hashes match and fresh samples still match", async () => {
      const { diskId, keepFile, deleteFile } = await setupFullHashCleanupGroup();
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/cleanup`, {
        initiatedFromWebUI: true,
        duplicateGroupId: 1,
        keepFile: { fileId: keepFile.id, path: keepFile.path },
        deleteFiles: [{ fileId: deleteFile.id, path: deleteFile.path }],
      }, { "User-Agent": "Mozilla/5.0" });

      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(1);
      expect(existsSync(keepFile.path)).toBe(true);
      expect(existsSync(deleteFile.path)).toBe(false);
    });

    it("bails before deletion when a file no longer matches the selected scan", async () => {
      const { diskId, keepFile, deleteFile } = await setupFullHashCleanupGroup();
      writeFileSync(deleteFile.path, "changed content!!");

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/cleanup`, {
        initiatedFromWebUI: true,
        duplicateGroupId: 1,
        keepFile: { fileId: keepFile.id, path: keepFile.path },
        deleteFiles: [{ fileId: deleteFile.id, path: deleteFile.path }],
      }, { "User-Agent": "Mozilla/5.0" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("no longer matches the selected scan");
      expect(existsSync(keepFile.path)).toBe(true);
      expect(existsSync(deleteFile.path)).toBe(true);
    });
  });

  // ── GET /api/disks/:id/duplicates/jobs ──────────────────────────

  describe("GET /api/disks/:id/duplicates/jobs", () => {
    it("returns empty list when no duplicate detection jobs exist", async () => {
      const diskId = insertDisk(ctx.db);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/jobs`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns jobs after inserting some", async () => {
      const diskId = insertDisk(ctx.db);

      const jobId = insertJob(ctx.db, {
        type: "duplicate_detection",
        status: "completed",
        target_disk_id: diskId,
      });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/jobs`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(jobId);
      expect(res.body[0].status).toBe("completed");
      expect(res.body[0].diskId).toBe(diskId);
    });

    it("does not return jobs for other disks", async () => {
      const diskA = insertDisk(ctx.db);
      const diskB = insertDisk(ctx.db);

      insertJob(ctx.db, { type: "duplicate_detection", status: "completed", target_disk_id: diskA });

      const res = await req(ctx.app, "GET", `/api/disks/${diskB}/duplicates/jobs`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
