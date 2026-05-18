import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

/**
 * Seed enough state for the suggestion-resolution path to work:
 *   - one scan job
 *   - one root directory + N files with full_hash
 *   - one completed duplicate_detection job referencing the scan
 *   - one full-hash duplicate group + member rows
 *
 * Returns the seeded IDs so each test can vary the path/hash combinations.
 */
function seedDuplicateGroup(
  ctx: TestContext,
  diskId: number,
  opts: {
    paths: string[];
    contentHash?: string;
    sizeBytes?: number;
  }
): {
  scanId: number;
  duplicateJobId: number;
  duplicateGroupId: number;
  files: Array<{ fileId: number; path: string }>;
} {
  const contentHash = opts.contentHash ?? "fullhash_a";
  const sampledHash = "sampled_a";
  const sizeBytes = opts.sizeBytes ?? 1024;

  const scanId = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
  ctx.db.prepare("UPDATE disks SET last_scan_job_id = ? WHERE id = ?").run(scanId, diskId);

  const dirRes = ctx.db
    .prepare(
      `INSERT INTO directories (disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(diskId, scanId, null, "/", "/root", 0, 0, 0) as { id: number };
  const directoryId = dirRes.id;

  const files: Array<{ fileId: number; path: string }> = [];
  for (const p of opts.paths) {
    const name = p.split("/").pop()!;
    const row = ctx.db
      .prepare(
        `INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(diskId, scanId, directoryId, name, p, sizeBytes, "2024-01-01T00:00:00Z", sampledHash, contentHash, 1) as { id: number };
    files.push({ fileId: row.id, path: p });
  }

  // Use prepared insert for duplicate_detection job because insertJob's CHECK
  // allowlist tracks one column subset; here we need payload_json.
  const dupJobRow = ctx.db
    .prepare(
      `INSERT INTO jobs (type, status, target_disk_id, payload_json, completed_at)
       VALUES ('duplicate_detection', 'completed', ?, ?, ?) RETURNING id`
    )
    .get(diskId, JSON.stringify({ scanId }), "2024-01-02T00:00:00Z") as { id: number };
  const duplicateJobId = dupJobRow.id;

  const groupRow = ctx.db
    .prepare(
      `INSERT INTO duplicate_groups
         (duplicate_job_id, hash_kind, content_hash, sampled_hash, file_count, size_bytes, wasted_bytes)
       VALUES (?, 'full', ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(duplicateJobId, contentHash, sampledHash, files.length, sizeBytes, sizeBytes * (files.length - 1)) as { id: number };
  const duplicateGroupId = groupRow.id;

  const insertMember = ctx.db.prepare(
    `INSERT INTO duplicate_group_files (group_id, file_id, path) VALUES (?, ?, ?)`
  );
  for (const f of files) insertMember.run(duplicateGroupId, f.fileId, f.path);

  return { scanId, duplicateJobId, duplicateGroupId, files };
}

describe("agent cleanup routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ── notes ───────────────────────────────────────────────────────────────

  describe("notes", () => {
    it("returns an empty body when no notes have been saved", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/notes`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ diskId, body: "", updatedAt: null });
    });

    it("round-trips body via PUT and GET", async () => {
      const diskId = insertDisk(ctx.db);
      const put = await req(ctx.app, "PUT", `/api/disks/${diskId}/cleanup/notes`, {
        body: "# rules\n- prefer /Photos\n",
      });
      expect(put.status).toBe(200);
      expect(put.body.body).toBe("# rules\n- prefer /Photos\n");
      expect(typeof put.body.updatedAt).toBe("string");

      const get = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/notes`);
      expect(get.body.body).toBe("# rules\n- prefer /Photos\n");
    });

    it("rejects non-string body", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "PUT", `/api/disks/${diskId}/cleanup/notes`, { body: 42 });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown disk", async () => {
      const res = await req(ctx.app, "GET", `/api/disks/9999/cleanup/notes`);
      expect(res.status).toBe(404);
    });
  });

  // ── suggestions creation + validation ───────────────────────────────────

  describe("POST /suggestions", () => {
    it("creates a pending suggestion", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/keep.bin",
        deletePaths: ["/a/delete.bin"],
        sizeBytes: 100,
        rationale: "keep shorter path",
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeGreaterThan(0);
    });

    it("rejects relative paths", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "a/keep.bin",
        deletePaths: ["/a/delete.bin"],
        sizeBytes: 100,
      });
      expect(res.status).toBe(400);
    });

    it("rejects when keepPath appears in deletePaths", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/x",
        deletePaths: ["/a/x"],
        sizeBytes: 100,
      });
      expect(res.status).toBe(400);
    });

    it("rejects duplicate deletePaths", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/keep.bin",
        deletePaths: ["/a/delete.bin", "/a/delete.bin"],
        sizeBytes: 100,
      });
      expect(res.status).toBe(400);
    });

    it("replaces the previous pending suggestion for the same content_hash", async () => {
      const diskId = insertDisk(ctx.db);
      const first = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/keep.bin",
        deletePaths: ["/a/old-target.bin"],
        sizeBytes: 100,
      });
      const second = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/keep.bin",
        deletePaths: ["/a/new-target.bin"],
        sizeBytes: 100,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.suggestions).toHaveLength(1);
      expect(list.body.suggestions[0].deletePaths).toEqual(["/a/new-target.bin"]);
    });
  });

  // ── suggestions resolution + lifecycle ──────────────────────────────────

  describe("GET /suggestions", () => {
    it("resolves a pending suggestion against the latest duplicate detection", async () => {
      const diskId = insertDisk(ctx.db);
      const seed = seedDuplicateGroup(ctx, diskId, {
        paths: ["/photos/a.jpg", "/downloads/a.jpg"],
        contentHash: "hash_a",
      });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "hash_a",
        keepPath: "/photos/a.jpg",
        deletePaths: ["/downloads/a.jpg"],
        sizeBytes: 1024,
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.status).toBe(200);
      expect(list.body.suggestions).toHaveLength(1);
      const s = list.body.suggestions[0];
      expect(s.resolved).toBe(true);
      expect(s.duplicateGroupId).toBe(seed.duplicateGroupId);
      expect(s.keepFile.path).toBe("/photos/a.jpg");
      expect(s.deleteFiles).toHaveLength(1);
      expect(s.deleteFiles[0].path).toBe("/downloads/a.jpg");
      expect(s.wastedBytes).toBe(1024);
    });

    it("marks a suggestion stale when the keep path is missing in the latest scan", async () => {
      const diskId = insertDisk(ctx.db);
      seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "fullhash_a",
        keepPath: "/photos/MISSING.jpg",
        deletePaths: ["/downloads/a.jpg"],
        sizeBytes: 1024,
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.suggestions[0].resolved).toBe(false);
      expect(list.body.suggestions[0].staleReason).toContain("keep path");
    });

    it("marks a suggestion stale when the content hash drifted on disk", async () => {
      const diskId = insertDisk(ctx.db);
      seedDuplicateGroup(ctx, diskId, {
        paths: ["/photos/a.jpg", "/downloads/a.jpg"],
        contentHash: "different_hash",
      });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "old_hash",
        keepPath: "/photos/a.jpg",
        deletePaths: ["/downloads/a.jpg"],
        sizeBytes: 1024,
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.suggestions[0].resolved).toBe(false);
      expect(list.body.suggestions[0].staleReason).toContain("hash drifted");
    });

    it("marks all suggestions stale when no duplicate detection has run", async () => {
      const diskId = insertDisk(ctx.db);
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/k.bin",
        deletePaths: ["/a/d.bin"],
        sizeBytes: 100,
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.duplicateJobId).toBeNull();
      expect(list.body.suggestions[0].resolved).toBe(false);
      expect(list.body.suggestions[0].staleReason).toContain("no completed duplicate detection");
    });

    it("survives a re-scan + re-detection — pending suggestion resolves against the NEW snapshot", async () => {
      const diskId = insertDisk(ctx.db);
      // Initial scan + detection.
      seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "fullhash_a",
        keepPath: "/photos/a.jpg",
        deletePaths: ["/downloads/a.jpg"],
        sizeBytes: 1024,
      });

      // Re-scan + re-detect: brand new scan_id, brand new file_ids, brand new duplicate group.
      const second = seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.duplicateJobId).toBe(second.duplicateJobId);
      const s = list.body.suggestions[0];
      expect(s.resolved).toBe(true);
      expect(s.duplicateGroupId).toBe(second.duplicateGroupId);
      // The fileIds in the response should be from the NEW scan, not the old one.
      expect(s.keepFile.fileId).toBe(second.files.find((f) => f.path === "/photos/a.jpg")!.fileId);
    });
  });

  describe("suggestion lifecycle", () => {
    it("marks a suggestion applied and removes it from the pending list", async () => {
      const diskId = insertDisk(ctx.db);
      seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "fullhash_a",
        keepPath: "/photos/a.jpg",
        deletePaths: ["/downloads/a.jpg"],
        sizeBytes: 1024,
      });
      const id = create.body.id;

      const apply = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions/${id}/applied`);
      expect(apply.status).toBe(200);
      expect(apply.body.status).toBe("applied");

      const pending = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(pending.body.suggestions).toHaveLength(0);

      const applied = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions?status=applied`);
      expect(applied.body.suggestions).toHaveLength(1);
      expect(applied.body.suggestions[0].status).toBe("applied");
    });

    it("marks a suggestion dismissed and removes it from the pending list", async () => {
      const diskId = insertDisk(ctx.db);
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/k.bin",
        deletePaths: ["/a/d.bin"],
        sizeBytes: 100,
      });
      const dismiss = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/dismissed`
      );
      expect(dismiss.status).toBe(200);

      const pending = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(pending.body.suggestions).toHaveLength(0);
    });

    it("rejects applied/dismissed transitions for a non-pending suggestion", async () => {
      const diskId = insertDisk(ctx.db);
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        contentHash: "h1",
        keepPath: "/a/k.bin",
        deletePaths: ["/a/d.bin"],
        sizeBytes: 100,
      });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/applied`);
      const again = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/applied`
      );
      expect(again.status).toBe(404);
    });
  });

  // ── history ─────────────────────────────────────────────────────────────

  describe("GET /history", () => {
    it("returns deletion events with sibling paths for each deletion", async () => {
      const diskId = insertDisk(ctx.db);
      const seed = seedDuplicateGroup(ctx, diskId, {
        paths: ["/photos/a.jpg", "/downloads/a.jpg", "/archive/a.jpg"],
      });
      // Mark /downloads/a.jpg deleted.
      const deletedFile = seed.files.find((f) => f.path === "/downloads/a.jpg")!;
      ctx.db
        .prepare(`INSERT INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)`)
        .run(deletedFile.fileId, seed.scanId, "2024-01-03T00:00:00Z");

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/history`);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      const e = res.body.events[0];
      expect(e.deletedPath).toBe("/downloads/a.jpg");
      // Siblings should include the surviving copies, with the non-deleted ones
      // (preferred "keep" candidates) listed first.
      expect(e.siblingPaths).toContain("/photos/a.jpg");
      expect(e.siblingPaths).toContain("/archive/a.jpg");
      expect(e.siblingPaths[0]).not.toBe("/downloads/a.jpg");
    });

    it("scopes history to the requested disk", async () => {
      const diskA = insertDisk(ctx.db);
      const diskB = insertDisk(ctx.db);
      const seedA = seedDuplicateGroup(ctx, diskA, { paths: ["/x/a", "/y/a"] });
      const seedB = seedDuplicateGroup(ctx, diskB, { paths: ["/x/b", "/y/b"] });
      ctx.db
        .prepare(`INSERT INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)`)
        .run(seedA.files[0].fileId, seedA.scanId, "2024-01-03T00:00:00Z");
      ctx.db
        .prepare(`INSERT INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)`)
        .run(seedB.files[0].fileId, seedB.scanId, "2024-01-04T00:00:00Z");

      const a = await req(ctx.app, "GET", `/api/disks/${diskA}/cleanup/history`);
      expect(a.body.events).toHaveLength(1);
      expect(a.body.events[0].deletedPath).toBe(seedA.files[0].path);

      const b = await req(ctx.app, "GET", `/api/disks/${diskB}/cleanup/history`);
      expect(b.body.events).toHaveLength(1);
      expect(b.body.events[0].deletedPath).toBe(seedB.files[0].path);
    });
  });
});
