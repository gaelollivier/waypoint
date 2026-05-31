import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";

function browserHeaders(): Record<string, string> {
  return { "User-Agent": "Mozilla/5.0 (Macintosh) Test/1" };
}

function agentHeaders(): Record<string, string> {
  return { "User-Agent": "curl/8.0" };
}

function getAuditRows(ctx: TestContext, action?: string) {
  if (action) {
    return ctx.db
      .prepare(
        `SELECT id, action, actor, user_agent, disk_id, target_kind, target_id, target_path,
                before_json, after_json, metadata_json
         FROM audit_log WHERE action = ? ORDER BY id`
      )
      .all(action) as Array<any>;
  }
  return ctx.db
    .prepare(
      `SELECT id, action, actor, user_agent, disk_id, target_kind, target_id, target_path,
              before_json, after_json, metadata_json
       FROM audit_log ORDER BY id`
    )
    .all() as Array<any>;
}

describe("audit log", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ───────────────────── excluded-paths ───────────────────────────────────

  describe("excluded-paths", () => {
    it("logs an entry when a path is added (browser actor)", async () => {
      const diskId = insertDisk(ctx.db);
      const r = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/excluded-paths`,
        { path: "/foo/bar", reason: "test" },
        browserHeaders()
      );
      expect(r.status).toBe(201);

      const rows = getAuditRows(ctx, "excluded_path_add");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe("ui");
      expect(rows[0].user_agent).toContain("Mozilla");
      expect(rows[0].disk_id).toBe(diskId);
      expect(rows[0].target_kind).toBe("excluded_path");
      expect(rows[0].target_path).toBe("/foo/bar");
      const after = JSON.parse(rows[0].after_json);
      expect(after.path).toBe("/foo/bar");
      expect(after.reason).toBe("test");
    });

    it("logs the actor as agent when the User-Agent is not a browser", async () => {
      const diskId = insertDisk(ctx.db);
      await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/excluded-paths`,
        { path: "/foo/bar" },
        agentHeaders()
      );
      const rows = getAuditRows(ctx, "excluded_path_add");
      expect(rows[0].actor).toBe("agent");
    });

    it("logs a remove entry with the prior row in before_json", async () => {
      const diskId = insertDisk(ctx.db);
      const created = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/excluded-paths`,
        { path: "/x", reason: "" },
        browserHeaders()
      );
      const exclusionId = created.body.id;

      const r = await req(
        ctx.app,
        "DELETE",
        `/api/disks/${diskId}/excluded-paths/${exclusionId}`,
        undefined,
        browserHeaders()
      );
      expect(r.status).toBe(200);

      const rows = getAuditRows(ctx, "excluded_path_remove");
      expect(rows).toHaveLength(1);
      const before = JSON.parse(rows[0].before_json);
      expect(before.id).toBe(exclusionId);
      expect(before.path).toBe("/x");
    });
  });

  // ───────────────────── cleanup notes ────────────────────────────────────

  describe("cleanup notes", () => {
    it("records before=null on first write, before=prior on update", async () => {
      const diskId = insertDisk(ctx.db);
      await req(
        ctx.app,
        "PUT",
        `/api/disks/${diskId}/cleanup/notes`,
        { body: "first" },
        browserHeaders()
      );
      await req(
        ctx.app,
        "PUT",
        `/api/disks/${diskId}/cleanup/notes`,
        { body: "second" },
        browserHeaders()
      );
      const rows = getAuditRows(ctx, "cleanup_notes_update");
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].before_json ?? "null")).toBeNull();
      expect(JSON.parse(rows[0].after_json).body).toBe("first");
      const beforeSecond = JSON.parse(rows[1].before_json);
      expect(beforeSecond.body).toBe("first");
      expect(JSON.parse(rows[1].after_json).body).toBe("second");
    });
  });

  // ───────────────────── cleanup suggestions ──────────────────────────────

  describe("cleanup suggestions", () => {
    it("logs creation with member snapshots, dismiss with status transition", async () => {
      const diskId = insertDisk(ctx.db);
      const created = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions`,
        {
          rationale: "test",
          members: [
            {
              contentHash: "h1",
              keepPath: "/k",
              deletePaths: ["/d1", "/d2"],
              sizeBytes: 100,
            },
          ],
        },
        agentHeaders()
      );
      expect(created.status).toBe(201);

      const createRows = getAuditRows(ctx, "cleanup_suggestion_create");
      expect(createRows).toHaveLength(1);
      expect(createRows[0].actor).toBe("agent");
      expect(createRows[0].target_id).toBe(created.body.id);
      const after = JSON.parse(createRows[0].after_json);
      expect(after.members[0].contentHash).toBe("h1");
      expect(after.members[0].deletePaths.sort()).toEqual(["/d1", "/d2"]);

      const dismissed = await req(
        ctx.app,
        "POST",
        `/api/disks/${diskId}/cleanup/suggestions/${created.body.id}/dismissed`,
        undefined,
        browserHeaders()
      );
      expect(dismissed.status).toBe(200);
      const dismissRows = getAuditRows(ctx, "cleanup_suggestion_dismiss");
      expect(dismissRows).toHaveLength(1);
      expect(JSON.parse(dismissRows[0].after_json).status).toBe("dismissed");
    });
  });

  // ───────────────────── comparisons ──────────────────────────────────────

  describe("comparisons", () => {
    it("logs batch create, member verdict, and batch delete", async () => {
      const batchRes = await req(
        ctx.app,
        "POST",
        `/api/comparisons`,
        {
          name: "B",
          members: [{ leftPath: "/a", rightPath: "/b" }],
        },
        browserHeaders()
      );
      expect(batchRes.status).toBe(201);
      const batchId = batchRes.body.id;

      const createRows = getAuditRows(ctx, "comparison_batch_create");
      expect(createRows).toHaveLength(1);
      const after = JSON.parse(createRows[0].after_json);
      expect(after.memberCount).toBe(1);

      // Find the member id
      const member = ctx.db
        .prepare("SELECT id FROM comparison_members WHERE batch_id = ?")
        .get(batchId) as { id: number };

      await req(
        ctx.app,
        "POST",
        `/api/comparisons/${batchId}/members/${member.id}/verdict`,
        { verdict: "same", note: "n" },
        browserHeaders()
      );
      const verdictRows = getAuditRows(ctx, "comparison_verdict");
      expect(verdictRows).toHaveLength(1);
      expect(JSON.parse(verdictRows[0].after_json).verdict).toBe("same");
      expect(JSON.parse(verdictRows[0].before_json).verdict).toBeNull();

      await req(
        ctx.app,
        "DELETE",
        `/api/comparisons/${batchId}`,
        undefined,
        browserHeaders()
      );
      const deleteRows = getAuditRows(ctx, "comparison_batch_delete");
      expect(deleteRows).toHaveLength(1);
      const before = JSON.parse(deleteRows[0].before_json);
      expect(before.batch.id).toBe(batchId);
      expect(before.members).toHaveLength(1);
    });
  });

  // ───────────────────── GET /api/audit ───────────────────────────────────

  describe("GET /api/audit", () => {
    it("returns entries newest first and supports filters + cursor", async () => {
      const diskId = insertDisk(ctx.db);
      // Generate a few audit rows via excluded-paths
      for (let i = 0; i < 5; i++) {
        await req(
          ctx.app,
          "POST",
          `/api/disks/${diskId}/excluded-paths`,
          { path: `/p${i}` },
          browserHeaders()
        );
      }

      const r = await req(ctx.app, "GET", `/api/audit?limit=2`);
      expect(r.status).toBe(200);
      expect(r.body.entries).toHaveLength(2);
      expect(r.body.truncated).toBe(true);
      expect(r.body.nextCursor).toBeTruthy();
      // Newest first → first entry was the last excluded-path created
      expect(r.body.entries[0].action).toBe("excluded_path_add");
      expect(r.body.entries[0].after.path).toBe("/p4");

      const r2 = await req(
        ctx.app,
        "GET",
        `/api/audit?limit=2&cursor=${encodeURIComponent(r.body.nextCursor)}`
      );
      expect(r2.body.entries[0].after.path).toBe("/p2");

      // Filter by action returns only matching entries.
      const fr = await req(ctx.app, "GET", `/api/audit?action=excluded_path_add&limit=0`);
      expect(fr.body.entries).toHaveLength(5);

      // Disk filter.
      const dr = await req(ctx.app, "GET", `/api/audit?diskId=${diskId}`);
      expect(dr.body.entries.length).toBe(5);
    });

    it("returns 404 for an unknown audit id", async () => {
      const r = await req(ctx.app, "GET", `/api/audit/9999`);
      expect(r.status).toBe(404);
    });
  });
});
