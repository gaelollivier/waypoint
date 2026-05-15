import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

/** Sets up a disk with a completed scan job and returns { diskId, scanId }. */
function setupScannedDisk(ctx: TestContext, label?: string): { diskId: number; scanId: number } {
  const diskId = insertDisk(ctx.db, { label: label ?? undefined });
  const scanId = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
  ctx.db.prepare("UPDATE disks SET last_scan_job_id = ? WHERE id = ?").run(scanId, diskId);
  return { diskId, scanId };
}

describe("tree routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ── GET /api/disks/:id/tree ─────────────────────────────────────

  describe("GET /api/disks/:id/tree", () => {
    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "GET", "/api/disks/9999/tree");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Disk not found");
    });

    it("returns empty entries for an unscanned disk", async () => {
      const diskId = insertDisk(ctx.db, { label: "Empty Disk" });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree`);
      expect(res.status).toBe(200);
      expect(res.body.diskId).toBe(diskId);
      expect(res.body.parentId).toBeNull();
      expect(res.body.parentPath).toBeNull();
      expect(res.body.entries).toEqual([]);
      expect(res.body.totalSizeBytes).toBe(0);
      expect(res.body.breadcrumb).toHaveLength(1);
      expect(res.body.breadcrumb[0].name).toBe("Empty Disk");
    });

    it("returns correct tree structure after inserting directory and file rows", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx, "TestDisk");

      // Insert root directory
      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(100, diskId, scanId, null, "TestDisk", "/mnt/test", 1500, 3, 2);

      // Insert subdirectory
      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(101, diskId, scanId, 100, "Photos", "/mnt/test/Photos", 500, 1, 1);

      // Insert files in root directory
      ctx.db
        .prepare(
          "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(diskId, scanId, 100, "readme.txt", "/mnt/test/readme.txt", 200, "2024-01-01", null, 1);
      ctx.db
        .prepare(
          "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(diskId, scanId, 100, "notes.txt", "/mnt/test/notes.txt", 800, "2024-02-01", "abc123", 1);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree`);
      expect(res.status).toBe(200);
      expect(res.body.diskId).toBe(diskId);
      expect(res.body.parentId).toBe(100);
      expect(res.body.parentPath).toBe("/mnt/test");
      expect(res.body.totalSizeBytes).toBe(1500);

      // 3 entries: 1 subdirectory + 2 files, sorted by size descending
      expect(res.body.entries).toHaveLength(3);

      // Largest first: notes.txt (800) > Photos dir (500) > readme.txt (200)
      expect(res.body.entries[0].name).toBe("notes.txt");
      expect(res.body.entries[0].kind).toBe("file");
      expect(res.body.entries[0].sizeBytes).toBe(800);
      expect(res.body.entries[0].sampledHash).toBe("abc123");

      expect(res.body.entries[1].name).toBe("Photos");
      expect(res.body.entries[1].kind).toBe("directory");
      expect(res.body.entries[1].sizeBytes).toBe(500);
      expect(res.body.entries[1].fileCount).toBe(1);

      expect(res.body.entries[2].name).toBe("readme.txt");
      expect(res.body.entries[2].kind).toBe("file");
      expect(res.body.entries[2].sizeBytes).toBe(200);
    });

    it("supports ?parentId to navigate into a subdirectory", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx, "TestDisk");

      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(100, diskId, scanId, null, "TestDisk", "/mnt/test", 1000, 2, 0);
      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(101, diskId, scanId, 100, "Photos", "/mnt/test/Photos", 500, 1, 1);
      ctx.db
        .prepare(
          "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(diskId, scanId, 101, "pic.jpg", "/mnt/test/Photos/pic.jpg", 500, "2024-03-01", 1);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree?parentId=101`);
      expect(res.status).toBe(200);
      expect(res.body.parentId).toBe(101);
      expect(res.body.parentPath).toBe("/mnt/test/Photos");
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].name).toBe("pic.jpg");
    });

    it("supports ?parentPath to navigate into a subdirectory", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx, "TestDisk");

      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(100, diskId, scanId, null, "TestDisk", "/mnt/test", 1000, 1, 0);
      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(101, diskId, scanId, 100, "Docs", "/mnt/test/Docs", 300, 1, 1);
      ctx.db
        .prepare(
          "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(diskId, scanId, 101, "doc.pdf", "/mnt/test/Docs/doc.pdf", 300, "2024-04-01", 1);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree?parentPath=/mnt/test/Docs`);
      expect(res.status).toBe(200);
      expect(res.body.parentId).toBe(101);
      expect(res.body.parentPath).toBe("/mnt/test/Docs");
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].name).toBe("doc.pdf");
    });

    it("returns empty entries for parentId on an unscanned disk", async () => {
      const diskId = insertDisk(ctx.db);

      // Unscanned disk has no scan_id, so tree returns empty regardless of parentId
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree?parentId=9999`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
    });

    it("returns 404 for parentId that does not exist on a scanned disk", async () => {
      const { diskId } = setupScannedDisk(ctx);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree?parentId=9999`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Directory not found");
    });

    it("returns 404 for parentPath that does not exist on this disk", async () => {
      const { diskId } = setupScannedDisk(ctx);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree?parentPath=/nonexistent`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Directory not found");
    });

    it("builds correct breadcrumb for nested directories", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx, "MyDisk");

      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(100, diskId, scanId, null, "MyDisk", "/mnt/mydisk", 1000, 1, 0);
      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(101, diskId, scanId, 100, "Photos", "/mnt/mydisk/Photos", 500, 1, 0);
      ctx.db
        .prepare(
          "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(102, diskId, scanId, 101, "2024", "/mnt/mydisk/Photos/2024", 200, 1, 1);

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/tree?parentId=102`);
      expect(res.status).toBe(200);
      // Breadcrumb: MyDisk > Photos > 2024
      expect(res.body.breadcrumb).toHaveLength(3);
      expect(res.body.breadcrumb[0].name).toBe("MyDisk"); // disk label used for root
      expect(res.body.breadcrumb[1].name).toBe("Photos");
      expect(res.body.breadcrumb[2].name).toBe("2024");
    });
  });
});
