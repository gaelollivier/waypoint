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

  // ── batch creation + validation ─────────────────────────────────────────

  describe("POST /suggestions (singleton batch)", () => {
    it("creates a pending singleton batch", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        rationale: "keep shorter path",
        members: [
          { contentHash: "h1", keepPath: "/a/keep.bin", deletePaths: ["/a/delete.bin"], sizeBytes: 100 },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeGreaterThan(0);
    });

    it("rejects empty members array", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [],
      });
      expect(res.status).toBe(400);
    });

    it("rejects relative paths inside a member", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "a/keep.bin", deletePaths: ["/a/delete.bin"], sizeBytes: 100 },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects when keepPath appears in deletePaths", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "/a/x", deletePaths: ["/a/x"], sizeBytes: 100 },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects duplicate deletePaths within a member", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          {
            contentHash: "h1",
            keepPath: "/a/keep.bin",
            deletePaths: ["/a/delete.bin", "/a/delete.bin"],
            sizeBytes: 100,
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects duplicate contentHash within a batch", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "/a/k.bin", deletePaths: ["/a/d.bin"], sizeBytes: 100 },
          { contentHash: "h1", keepPath: "/b/k.bin", deletePaths: ["/b/d.bin"], sizeBytes: 100 },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("replaces a previous pending batch with the same batchKey", async () => {
      const diskId = insertDisk(ctx.db);
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        batchKey: "folder-pair-A",
        members: [
          { contentHash: "h1", keepPath: "/a/k.bin", deletePaths: ["/a/old-target.bin"], sizeBytes: 100 },
        ],
      });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        batchKey: "folder-pair-A",
        members: [
          { contentHash: "h2", keepPath: "/a/k.bin", deletePaths: ["/a/new-target.bin"], sizeBytes: 100 },
        ],
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.suggestions).toHaveLength(1);
      expect(list.body.suggestions[0].members).toHaveLength(1);
      expect(list.body.suggestions[0].members[0].deletePaths).toEqual(["/a/new-target.bin"]);
    });

    it("creates a multi-member batch", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        rationale: "delete every file in /backup-folder/ that also lives in /source-folder/",
        batchKey: "folder-pair:source|backup",
        members: [
          { contentHash: "h1", keepPath: "/source-folder/a.bin", deletePaths: ["/backup-folder/a.bin"], sizeBytes: 1000 },
          { contentHash: "h2", keepPath: "/source-folder/b.bin", deletePaths: ["/backup-folder/b.bin"], sizeBytes: 2000 },
          { contentHash: "h3", keepPath: "/source-folder/c.bin", deletePaths: ["/backup-folder/c.bin"], sizeBytes: 3000 },
        ],
      });
      expect(res.status).toBe(201);

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.suggestions).toHaveLength(1);
      const s = list.body.suggestions[0];
      expect(s.memberCount).toBe(3);
      expect(s.totalSizeBytes).toBe(6000);
      expect(s.totalWastedBytes).toBe(6000); // 1 delete each × per-file size
    });
  });

  // ── resolution ──────────────────────────────────────────────────────────

  describe("GET /suggestions (resolution per member)", () => {
    it("resolves each member of a singleton batch", async () => {
      const diskId = insertDisk(ctx.db);
      const seed = seedDuplicateGroup(ctx, diskId, {
        paths: ["/photos/a.jpg", "/downloads/a.jpg"],
        contentHash: "hash_a",
      });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "hash_a", keepPath: "/photos/a.jpg", deletePaths: ["/downloads/a.jpg"], sizeBytes: 1024 },
        ],
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.status).toBe(200);
      expect(list.body.suggestions).toHaveLength(1);
      const s = list.body.suggestions[0];
      expect(s.allResolved).toBe(true);
      expect(s.members).toHaveLength(1);
      const m = s.members[0];
      expect(m.resolved).toBe(true);
      expect(m.duplicateGroupId).toBe(seed.duplicateGroupId);
      expect(m.keepFile.path).toBe("/photos/a.jpg");
      expect(m.deleteFiles).toHaveLength(1);
    });

    it("marks one member stale while leaving the other resolved (allResolved=false)", async () => {
      const diskId = insertDisk(ctx.db);
      // Seed two distinct groups so one member resolves and one doesn't.
      seedDuplicateGroup(ctx, diskId, {
        paths: ["/x/a.jpg", "/y/a.jpg"],
        contentHash: "hash_a",
      });
      // No seeding for hash_b — the suggestion's second member won't resolve.
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "hash_a", keepPath: "/x/a.jpg", deletePaths: ["/y/a.jpg"], sizeBytes: 1024 },
          { contentHash: "hash_b", keepPath: "/x/b.jpg", deletePaths: ["/y/b.jpg"], sizeBytes: 2048 },
        ],
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      const s = list.body.suggestions[0];
      expect(s.allResolved).toBe(false);
      expect(s.members[0].resolved).toBe(true);
      expect(s.members[1].resolved).toBe(false);
    });

    it("survives a re-scan + re-detection: each member re-resolves against the new snapshot", async () => {
      const diskId = insertDisk(ctx.db);
      seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "fullhash_a", keepPath: "/photos/a.jpg", deletePaths: ["/downloads/a.jpg"], sizeBytes: 1024 },
        ],
      });

      // Brand-new scan + detection — new file_ids, new group_id.
      const second = seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.duplicateJobId).toBe(second.duplicateJobId);
      const m = list.body.suggestions[0].members[0];
      expect(m.resolved).toBe(true);
      expect(m.duplicateGroupId).toBe(second.duplicateGroupId);
      expect(m.keepFile.fileId).toBe(second.files.find((f) => f.path === "/photos/a.jpg")!.fileId);
    });

    it("marks every member stale when no duplicate detection has run", async () => {
      const diskId = insertDisk(ctx.db);
      await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "/a/k.bin", deletePaths: ["/a/d.bin"], sizeBytes: 100 },
        ],
      });

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/suggestions`);
      expect(list.body.duplicateJobId).toBeNull();
      expect(list.body.suggestions[0].allResolved).toBe(false);
      expect(list.body.suggestions[0].members[0].resolved).toBe(false);
    });
  });

  // ── batch apply (request-shape failures only — the disk-write path
  //    is covered by integration tests on the cleanup helper itself) ───────

  describe("POST /suggestions/:id/apply", () => {
    it("rejects non-browser user agents (403)", async () => {
      const diskId = insertDisk(ctx.db);
      seedDuplicateGroup(ctx, diskId, { paths: ["/photos/a.jpg", "/downloads/a.jpg"] });
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "fullhash_a", keepPath: "/photos/a.jpg", deletePaths: ["/downloads/a.jpg"], sizeBytes: 1024 },
        ],
      });
      const apply = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/apply`,
        { initiatedFromWebUI: true }
        // No browser UA header in the helper's default request — should be rejected.
      );
      expect(apply.status).toBe(403);
    });

    it("rejects requests without initiatedFromWebUI (403)", async () => {
      const diskId = insertDisk(ctx.db);
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "/a/k.bin", deletePaths: ["/a/d.bin"], sizeBytes: 100 },
        ],
      });
      const apply = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/apply`,
        {},
        { "User-Agent": "Mozilla/5.0 testing" }
      );
      expect(apply.status).toBe(403);
    });

    it("refuses to apply when no duplicate detection exists (409)", async () => {
      const diskId = insertDisk(ctx.db, { mount_path: "/tmp/test-mount", is_connected: 1 });
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "/a/k.bin", deletePaths: ["/a/d.bin"], sizeBytes: 100 },
        ],
      });
      const apply = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/apply`,
        { initiatedFromWebUI: true },
        { "User-Agent": "Mozilla/5.0 testing" }
      );
      expect(apply.status).toBe(409);
      expect(apply.body.error).toContain("No completed duplicate detection");
    });

    it("refuses to apply a batch when one member is stale (409)", async () => {
      const diskId = insertDisk(ctx.db, { mount_path: "/tmp/test-mount", is_connected: 1 });
      seedDuplicateGroup(ctx, diskId, {
        paths: ["/x/a.jpg", "/y/a.jpg"],
        contentHash: "hash_a",
      });
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "hash_a", keepPath: "/x/a.jpg", deletePaths: ["/y/a.jpg"], sizeBytes: 1024 },
          { contentHash: "missing", keepPath: "/x/b.jpg", deletePaths: ["/y/b.jpg"], sizeBytes: 1024 },
        ],
      });
      const apply = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${create.body.id}/apply`,
        { initiatedFromWebUI: true },
        { "User-Agent": "Mozilla/5.0 testing" }
      );
      expect(apply.status).toBe(409);
      expect(apply.body.error).toContain("stale");
    });
  });

  describe("dismiss", () => {
    it("marks a suggestion dismissed and removes it from the pending list", async () => {
      const diskId = insertDisk(ctx.db);
      const create = await req(ctx.app, "POST", `/api/disks/${diskId}/cleanup/suggestions`, {
        members: [
          { contentHash: "h1", keepPath: "/a/k.bin", deletePaths: ["/a/d.bin"], sizeBytes: 100 },
        ],
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
  });

  // ── history ─────────────────────────────────────────────────────────────

  describe("GET /history", () => {
    it("returns deletion events with sibling paths for each deletion", async () => {
      const diskId = insertDisk(ctx.db);
      const seed = seedDuplicateGroup(ctx, diskId, {
        paths: ["/photos/a.jpg", "/downloads/a.jpg", "/archive/a.jpg"],
      });
      const deletedFile = seed.files.find((f) => f.path === "/downloads/a.jpg")!;
      ctx.db
        .prepare(`INSERT INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)`)
        .run(deletedFile.fileId, seed.scanId, "2024-01-03T00:00:00Z");

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/cleanup/history`);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      const e = res.body.events[0];
      expect(e.deletedPath).toBe("/downloads/a.jpg");
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
