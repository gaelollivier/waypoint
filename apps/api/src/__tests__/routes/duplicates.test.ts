import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
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
  // When the path points at a real on-disk file (cleanup tests do this so the
  // freshness re-check has something to read), capture its current size/mtime
  // so the freshness check will pass. Synthetic paths fall back to the legacy
  // placeholder values — those tests never reach the freshness check.
  let sizeBytes = 100;
  let mtime = "2024-01-01";
  if (existsSync(filePath)) {
    const s = statSync(filePath);
    sizeBytes = s.size;
    mtime = new Date(s.mtimeMs).toISOString();
  }
  ctx.db
    .prepare(
      "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(diskId, scanId, directoryId, name, filePath, sizeBytes, mtime, sampledHash, fullHash, 1);
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

    it("halts on first deletion failure and returns 500 with partial progress", async () => {
      // Two delete files: A inside the mount (will succeed), B outside the
      // mount (gateway's isWithinMount throws → halt). The freshness
      // recheck loop passes for both since it doesn't validate path
      // containment, so we reach the deletion loop.
      const mount = makeRoot();
      const outside = makeRoot();
      const keepPath = path.join(mount, "keep.txt");
      const deleteAPath = path.join(mount, "delete-a.txt");
      const deleteBPath = path.join(outside, "delete-b.txt");
      writeFileSync(keepPath, "identical content");
      writeFileSync(deleteAPath, "identical content");
      writeFileSync(deleteBPath, "identical content");

      const diskId = insertDisk(ctx.db, { mount_path: mount, is_connected: 1 });
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 100, "Root", mount);

      const sampledHash = await computeSampledHash(keepPath, 17);
      const fullHash = await computeFullHashStreaming(keepPath);
      insertFileWithFullHash(ctx, diskId, scanId, 100, "keep.txt",     keepPath,    sampledHash, fullHash);
      insertFileWithFullHash(ctx, diskId, scanId, 100, "delete-a.txt", deleteAPath, sampledHash, fullHash);
      insertFileWithFullHash(ctx, diskId, scanId, 100, "delete-b.txt", deleteBPath, sampledHash, fullHash);

      const files = ctx.db
        .prepare("SELECT id, path FROM files WHERE scan_id = ? ORDER BY path")
        .all(scanId) as Array<{ id: number; path: string }>;
      const keepFile = files.find((f) => f.path === keepPath)!;
      const deleteA  = files.find((f) => f.path === deleteAPath)!;
      const deleteB  = files.find((f) => f.path === deleteBPath)!;

      const jobId = insertJob(ctx.db, { type: "duplicate_detection", status: "completed", target_disk_id: diskId });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);
      ctx.db.prepare(
        "INSERT INTO duplicate_groups (id, duplicate_job_id, hash_kind, content_hash, sampled_hash, file_count, size_bytes, wasted_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "full", fullHash, sampledHash, 3, 17, 34);
      for (const file of files) {
        ctx.db.prepare("INSERT INTO duplicate_group_files (group_id, file_id, path) VALUES (?, ?, ?)")
          .run(1, file.id, file.path);
      }

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/cleanup`, {
        initiatedFromWebUI: true,
        duplicateGroupId: 1,
        keepFile: { fileId: keepFile.id, path: keepFile.path },
        deleteFiles: [
          { fileId: deleteA.id, path: deleteA.path },
          { fileId: deleteB.id, path: deleteB.path },
        ],
      }, { "User-Agent": "Mozilla/5.0" });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain("Cleanup halted");
      expect(res.body.deletedCount).toBe(1);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].fileId).toBe(deleteA.id);
      expect(res.body.failedAt.fileId).toBe(deleteB.id);
      expect(res.body.failedAt.path).toBe(deleteBPath);

      // A is gone, B is intact
      expect(existsSync(deleteAPath)).toBe(false);
      expect(existsSync(deleteBPath)).toBe(true);
      expect(existsSync(keepPath)).toBe(true);

      // DB reflects deletion of A and not B: deleted_files has a row for A
      // (scoped to the scan the cleanup ran against), and no row for B.
      const aDel = ctx.db
        .prepare("SELECT deleted_at FROM deleted_files WHERE file_id = ?")
        .get(deleteA.id) as { deleted_at: string } | null;
      const bDel = ctx.db
        .prepare("SELECT deleted_at FROM deleted_files WHERE file_id = ?")
        .get(deleteB.id) as { deleted_at: string } | null;
      expect(aDel?.deleted_at).toBeTruthy();
      expect(bDel).toBeNull();

      // Event log records the halt
      const events = ctx.db
        .prepare("SELECT level, category, message FROM job_events WHERE job_id = ?")
        .all(jobId) as Array<{ level: string; category: string; message: string }>;
      const halt = events.find((e) => e.category === "duplicate_cleanup_halted");
      expect(halt).toBeDefined();
      expect(halt!.level).toBe("error");
    });
  });

  // ── POST /api/disks/:id/duplicates/directories/cleanup ──────────

  describe("POST /api/disks/:id/duplicates/directories/cleanup", () => {
    it("rejects requests without browser User-Agent", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/directories/cleanup`, {
        initiatedFromWebUI: true,
        duplicateDirectoryGroupId: 1,
        keepDirectory: { directoryId: 1, path: "/mnt/a" },
        deleteDirectories: [{ directoryId: 2, path: "/mnt/b", files: [] }],
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("web browser");
    });

    it("rejects requests without initiatedFromWebUI", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/directories/cleanup`, {
        duplicateDirectoryGroupId: 1,
        keepDirectory: { directoryId: 1, path: "/mnt/a" },
        deleteDirectories: [{ directoryId: 2, path: "/mnt/b", files: [] }],
      }, { "User-Agent": "Mozilla/5.0" });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("initiatedFromWebUI");
    });

    it("rejects when the group is not eligible for cleanup", async () => {
      const diskId = insertDisk(ctx.db, { mount_path: "/mnt", is_connected: 1 });
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 1, "Root", "/mnt");

      const jobId = insertJob(ctx.db, {
        type: "duplicate_detection",
        status: "completed",
        target_disk_id: diskId,
      });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_groups (id, duplicate_job_id, content_hash, directory_count, total_size_bytes, wasted_bytes, is_eligible_for_cleanup) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "h", 2, 100, 100, 0);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 10, "/mnt/a");
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 20, "/mnt/b");

      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/directories/cleanup`, {
        initiatedFromWebUI: true,
        duplicateDirectoryGroupId: 1,
        keepDirectory: { directoryId: 10, path: "/mnt/a" },
        deleteDirectories: [{ directoryId: 20, path: "/mnt/b", files: [{ fileId: 1, relativePath: "x" }] }],
      }, { "User-Agent": "Mozilla/5.0" });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("not eligible");
    });

    it("rejects when delete count equals group directory_count", async () => {
      const diskId = insertDisk(ctx.db, { mount_path: "/mnt", is_connected: 1 });
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 1, "Root", "/mnt");
      const jobId = insertJob(ctx.db, {
        type: "duplicate_detection", status: "completed", target_disk_id: diskId,
      });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_groups (id, duplicate_job_id, content_hash, directory_count, total_size_bytes, wasted_bytes, is_eligible_for_cleanup) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "h", 2, 100, 100, 1);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 10, "/mnt/a");
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 20, "/mnt/b");

      // Two distinct delete directories against a 2-copy group — would
      // wipe every copy, leaving nothing kept. Route must refuse.
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/duplicates/directories/cleanup`, {
        initiatedFromWebUI: true,
        duplicateDirectoryGroupId: 1,
        keepDirectory: { directoryId: 10, path: "/mnt/a" },
        deleteDirectories: [
          { directoryId: 20, path: "/mnt/b", files: [{ fileId: 1, relativePath: "x" }] },
          { directoryId: 30, path: "/mnt/c", files: [{ fileId: 2, relativePath: "x" }] },
        ],
      }, { "User-Agent": "Mozilla/5.0" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("at least one must remain");
    });
  });

  // ── GET /api/disks/:id/duplicates/directories/:groupId/files ────

  describe("GET /api/disks/:id/duplicates/directories/:groupId/files", () => {
    it("returns 404 when the directory group does not belong to a completed job for this disk", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/directories/999/files`);
      expect(res.status).toBe(404);
    });

    it("returns per-member file lists with relative paths and full-hash status", async () => {
      const diskId = insertDisk(ctx.db);
      const scanId = setupScan(ctx, diskId);

      // Two directory members: /mnt/a and /mnt/b, identical 2-file structure.
      insertDirectory(ctx, diskId, scanId, 1, "Root",    "/mnt");
      insertDirectory(ctx, diskId, scanId, 10, "a",      "/mnt/a");
      insertDirectory(ctx, diskId, scanId, 20, "b",      "/mnt/b");
      // Make a/b parented to root so the descendant walk finds them.
      ctx.db.prepare("UPDATE directories SET parent_id = 1 WHERE id IN (10, 20)").run();

      insertFileWithFullHash(ctx, diskId, scanId, 10, "x.txt", "/mnt/a/x.txt", "sx", "fx");
      insertFileWithHash    (ctx, diskId, scanId, 10, "y.txt", "/mnt/a/y.txt", "sy"); // no full hash
      insertFileWithFullHash(ctx, diskId, scanId, 20, "x.txt", "/mnt/b/x.txt", "sx", "fx");
      insertFileWithHash    (ctx, diskId, scanId, 20, "y.txt", "/mnt/b/y.txt", "sy");

      const jobId = insertJob(ctx.db, {
        type: "duplicate_detection",
        status: "completed",
        target_disk_id: diskId,
      });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);

      ctx.db.prepare(
        "INSERT INTO duplicate_directory_groups (id, duplicate_job_id, content_hash, directory_count, total_size_bytes, wasted_bytes, is_eligible_for_cleanup) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "dirhash", 2, 200, 200, 0);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 10, "/mnt/a");
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 20, "/mnt/b");

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/directories/1/files`);
      expect(res.status).toBe(200);
      expect(res.body.groupId).toBe(1);
      expect(res.body.canDelete).toBe(false);
      expect(res.body.members).toHaveLength(2);

      const a = res.body.members.find((m: any) => m.path === "/mnt/a");
      expect(a.files).toHaveLength(2);
      const ax = a.files.find((f: any) => f.relativePath === "x.txt");
      const ay = a.files.find((f: any) => f.relativePath === "y.txt");
      expect(ax.hasFullHash).toBe(true);
      expect(ay.hasFullHash).toBe(false);
      expect(ax.path).toBe("/mnt/a/x.txt");
    });
  });

  // ── GET /api/disks/:id/duplicates/directories/:groupId/inventory ────

  describe("GET /api/disks/:id/duplicates/directories/:groupId/inventory", () => {
    it("returns 404 when the directory group does not belong to a completed job for this disk", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/directories/999/inventory`);
      expect(res.status).toBe(404);
    });

    it("categorizes on-disk files into scanned / excluded / unknown / missing", async () => {
      const root = makeRoot();
      const memberA = path.join(root, "a");
      const memberB = path.join(root, "b");
      // Build the real on-disk tree first so the categorization has something to walk.
      ctx.db; // silence unused warning
      writeFileSync; // ensure import is loaded
      const memberAFile1 = path.join(memberA, "x.txt");
      const memberAFile2 = path.join(memberA, "y.txt");
      const memberADsStore = path.join(memberA, ".DS_Store");
      const memberAExtra = path.join(memberA, "extra.txt");
      const memberBFile1 = path.join(memberB, "x.txt");
      const memberBFile2 = path.join(memberB, "y.txt");
      // We rely on Node fs to make these — same as other tests in this file.
      // require("fs").mkdirSync would not respect helper conventions; use writeFileSync after mkdirSync:
      const { mkdirSync } = require("fs");
      mkdirSync(memberA, { recursive: true });
      mkdirSync(memberB, { recursive: true });
      writeFileSync(memberAFile1, "x-content");
      writeFileSync(memberAFile2, "y-content");
      writeFileSync(memberADsStore, "finder noise");
      writeFileSync(memberAExtra, "user file not in scan");
      writeFileSync(memberBFile1, "x-content");
      // memberBFile2 intentionally not on disk — should surface as "missing"

      const diskId = insertDisk(ctx.db, { mount_path: root });
      const scanId = setupScan(ctx, diskId);

      insertDirectory(ctx, diskId, scanId, 1, "Root", root);
      insertDirectory(ctx, diskId, scanId, 10, "a", memberA);
      insertDirectory(ctx, diskId, scanId, 20, "b", memberB);
      ctx.db.prepare("UPDATE directories SET parent_id = 1 WHERE id IN (10, 20)").run();

      insertFileWithFullHash(ctx, diskId, scanId, 10, "x.txt", memberAFile1, "sx", "fx");
      insertFileWithFullHash(ctx, diskId, scanId, 10, "y.txt", memberAFile2, "sy", "fy");
      insertFileWithFullHash(ctx, diskId, scanId, 20, "x.txt", memberBFile1, "sx", "fx");
      insertFileWithFullHash(ctx, diskId, scanId, 20, "y.txt", memberBFile2, "sy", "fy");

      const jobId = insertJob(ctx.db, {
        type: "duplicate_detection",
        status: "completed",
        target_disk_id: diskId,
      });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);

      ctx.db.prepare(
        "INSERT INTO duplicate_directory_groups (id, duplicate_job_id, content_hash, directory_count, total_size_bytes, wasted_bytes, is_eligible_for_cleanup) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "dirhash", 2, 200, 200, 1);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 10, memberA);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 20, memberB);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/directories/1/inventory`);
      expect(res.status).toBe(200);
      expect(res.body.canDelete).toBe(true);
      expect(res.body.members).toHaveLength(2);

      const a = res.body.members.find((m: any) => m.path === memberA);
      expect(a.directoryExists).toBe(true);
      expect(a.scanned.map((f: any) => f.relativePath).sort()).toEqual(["x.txt", "y.txt"]);
      expect(a.excluded.map((f: any) => f.relativePath)).toEqual([".DS_Store"]);
      expect(a.unknown.map((f: any) => f.relativePath)).toEqual(["extra.txt"]);
      expect(a.missing).toEqual([]);

      const b = res.body.members.find((m: any) => m.path === memberB);
      expect(b.scanned.map((f: any) => f.relativePath)).toEqual(["x.txt"]);
      expect(b.missing.map((f: any) => f.relativePath)).toEqual(["y.txt"]);
    });

    it("reports directoryExists=false when a member directory has been removed from disk", async () => {
      const root = makeRoot();
      const memberA = path.join(root, "a");
      // Don't create memberA on disk — simulating user manually deleted it.

      const diskId = insertDisk(ctx.db, { mount_path: root });
      const scanId = setupScan(ctx, diskId);
      insertDirectory(ctx, diskId, scanId, 10, "a", memberA);
      insertFileWithFullHash(ctx, diskId, scanId, 10, "x.txt", path.join(memberA, "x.txt"), "sx", "fx");

      const jobId = insertJob(ctx.db, {
        type: "duplicate_detection",
        status: "completed",
        target_disk_id: diskId,
      });
      ctx.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify({ scanId }), jobId);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_groups (id, duplicate_job_id, content_hash, directory_count, total_size_bytes, wasted_bytes, is_eligible_for_cleanup) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(1, jobId, "dirhash", 1, 100, 0, 1);
      ctx.db.prepare(
        "INSERT INTO duplicate_directory_group_members (group_id, directory_id, path) VALUES (?, ?, ?)"
      ).run(1, 10, memberA);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/duplicates/directories/1/inventory`);
      expect(res.status).toBe(200);
      const m = res.body.members[0];
      expect(m.directoryExists).toBe(false);
      expect(m.scanned).toEqual([]);
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
