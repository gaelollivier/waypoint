import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";

describe("excluded-paths routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  describe("list", () => {
    it("returns an empty list when nothing is excluded", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/excluded-paths`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ diskId, exclusions: [] });
    });

    it("404s for unknown disks", async () => {
      const res = await req(ctx.app, "GET", `/api/disks/999/excluded-paths`);
      expect(res.status).toBe(404);
    });

    it("returns rows for the requested disk only", async () => {
      const a = insertDisk(ctx.db);
      const b = insertDisk(ctx.db);
      ctx.db
        .prepare(`INSERT INTO excluded_paths (disk_id, path, reason) VALUES (?, ?, ?)`)
        .run(a, "/Volumes/a/foo", "self-contained archive");
      ctx.db
        .prepare(`INSERT INTO excluded_paths (disk_id, path, reason) VALUES (?, ?, ?)`)
        .run(b, "/Volumes/b/bar", "");

      const res = await req(ctx.app, "GET", `/api/disks/${a}/excluded-paths`);
      expect(res.status).toBe(200);
      expect(res.body.exclusions).toHaveLength(1);
      expect(res.body.exclusions[0].path).toBe("/Volumes/a/foo");
      expect(res.body.exclusions[0].reason).toBe("self-contained archive");
    });
  });

  describe("create", () => {
    it("creates an exclusion with reason", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "/Volumes/disk/Archive",
        reason: "intentional duplicates",
      });
      expect(res.status).toBe(201);
      expect(res.body.path).toBe("/Volumes/disk/Archive");
      expect(res.body.reason).toBe("intentional duplicates");
      expect(res.body.diskId).toBe(diskId);
    });

    it("strips a trailing slash before storing", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "/Volumes/disk/Archive/",
      });
      expect(res.status).toBe(201);
      expect(res.body.path).toBe("/Volumes/disk/Archive");
    });

    it("returns the existing row on duplicate path", async () => {
      const diskId = insertDisk(ctx.db);
      const first = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "/Volumes/disk/Archive",
      });
      const second = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "/Volumes/disk/Archive",
        reason: "different reason",
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      // Reason from the first create is preserved (POST is idempotent on path).
      expect(second.body.reason).toBe("");
    });

    it("rejects relative paths", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "relative/path",
      });
      expect(res.status).toBe(400);
    });

    it("rejects the filesystem root", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "/",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("delete", () => {
    it("removes a row owned by the disk", async () => {
      const diskId = insertDisk(ctx.db);
      const created = await req(ctx.app, "POST", `/api/disks/${diskId}/excluded-paths`, {
        path: "/Volumes/disk/Archive",
      });
      const res = await req(
        ctx.app,
        "DELETE",
        `/api/disks/${diskId}/excluded-paths/${created.body.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      const list = await req(ctx.app, "GET", `/api/disks/${diskId}/excluded-paths`);
      expect(list.body.exclusions).toHaveLength(0);
    });

    it("404s when the row belongs to another disk", async () => {
      const a = insertDisk(ctx.db);
      const b = insertDisk(ctx.db);
      const created = await req(ctx.app, "POST", `/api/disks/${a}/excluded-paths`, {
        path: "/Volumes/a/foo",
      });
      const res = await req(
        ctx.app,
        "DELETE",
        `/api/disks/${b}/excluded-paths/${created.body.id}`
      );
      expect(res.status).toBe(404);
    });
  });
});
