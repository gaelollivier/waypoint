import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, type TestContext } from "./helpers";

describe("comparisons routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  describe("create batch", () => {
    it("creates a batch with one member", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        name: "Google_Backup vs Photos-Videos sample",
        rationale: "sidecar-year + size band suggests overlap",
        members: [
          {
            leftPath: "/Volumes/Data/Google_Backup/foo.mp4",
            leftSizeBytes: 12_345,
            leftContentHash: "abc123",
            rightPath: "/Volumes/Data/Photos - Videos/2022/foo.mp4",
            rightSizeBytes: 12_300,
            note: "size band ±1%",
          },
        ],
      });
      expect(res.status).toBe(201);
      expect(typeof res.body.id).toBe("number");
    });

    it("creates with multiple members in array order", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        name: "batch",
        members: [
          { leftPath: "/a/1", rightPath: "/b/1" },
          { leftPath: "/a/2", rightPath: "/b/2" },
          { leftPath: "/a/3", rightPath: "/b/3" },
        ],
      });
      expect(res.status).toBe(201);

      const get = await req(ctx.app, "GET", `/api/comparisons/${res.body.id}`);
      expect(get.status).toBe(200);
      expect(get.body.kind).toBe("dedup");
      expect(get.body.sampleId).toBeNull();
      expect(get.body.members).toHaveLength(3);
      expect(get.body.members[0].position).toBe(0);
      expect(get.body.members[0].left.path).toBe("/a/1");
      expect(get.body.members[2].position).toBe(2);
      expect(get.body.progress.total).toBe(3);
      expect(get.body.progress.pending).toBe(3);
    });

    it("rejects missing name", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        members: [{ leftPath: "/a", rightPath: "/b" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty members array", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [],
      });
      expect(res.status).toBe(400);
    });

    it("rejects relative paths", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [{ leftPath: "rel/path", rightPath: "/b" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects same left and right", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [{ leftPath: "/same", rightPath: "/same" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects negative sizes", async () => {
      const res = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [{ leftPath: "/a", rightPath: "/b", leftSizeBytes: -1 }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("list and get", () => {
    it("lists batches newest first with progress", async () => {
      const a = await req(ctx.app, "POST", "/api/comparisons", {
        name: "first",
        members: [{ leftPath: "/a", rightPath: "/b" }],
      });
      const b = await req(ctx.app, "POST", "/api/comparisons", {
        name: "second",
        members: [
          { leftPath: "/c", rightPath: "/d" },
          { leftPath: "/e", rightPath: "/f" },
        ],
      });

      const list = await req(ctx.app, "GET", "/api/comparisons");
      expect(list.status).toBe(200);
      expect(list.body.batches.map((x: { id: number }) => x.id)).toEqual([
        b.body.id,
        a.body.id,
      ]);
      expect(list.body.batches[0].progress.total).toBe(2);
      expect(list.body.batches[1].progress.total).toBe(1);
    });

    it("404s on unknown batch", async () => {
      const res = await req(ctx.app, "GET", "/api/comparisons/9999");
      expect(res.status).toBe(404);
    });
  });

  describe("verdict", () => {
    it("records a verdict and updates progress", async () => {
      const create = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [
          { leftPath: "/a/1", rightPath: "/b/1" },
          { leftPath: "/a/2", rightPath: "/b/2" },
        ],
      });
      const batchId = create.body.id;
      const get = await req(ctx.app, "GET", `/api/comparisons/${batchId}`);
      const firstMemberId = get.body.members[0].id;

      const v = await req(
        ctx.app,
        "POST",
        `/api/comparisons/${batchId}/members/${firstMemberId}/verdict`,
        { verdict: "same", note: "obviously identical" }
      );
      expect(v.status).toBe(200);
      expect(v.body.verdict).toBe("same");
      expect(v.body.verdictNote).toBe("obviously identical");
      expect(typeof v.body.verdictedAt).toBe("string");

      const after = await req(ctx.app, "GET", `/api/comparisons/${batchId}`);
      expect(after.body.progress.same).toBe(1);
      expect(after.body.progress.pending).toBe(1);
    });

    it("accepts preference verdicts only for encoding frame batches", async () => {
      const dedup = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [{ leftPath: "/a", rightPath: "/b" }],
      });
      const dedupGet = await req(ctx.app, "GET", `/api/comparisons/${dedup.body.id}`);
      const dedupMemberId = dedupGet.body.members[0].id;
      const rejected = await req(
        ctx.app,
        "POST",
        `/api/comparisons/${dedup.body.id}/members/${dedupMemberId}/verdict`,
        { verdict: "prefer_left" }
      );
      expect(rejected.status).toBe(400);

      const batch = ctx.db
        .prepare(
          `INSERT INTO comparison_batches (name, rationale, kind)
           VALUES (?, ?, 'encoding_frames') RETURNING id`
        )
        .get("enc", "") as { id: number };
      const member = ctx.db
        .prepare(
          `INSERT INTO comparison_members
             (batch_id, position, left_path, right_path)
           VALUES (?, ?, ?, ?) RETURNING id`
        )
        .get(batch.id, 0, "/scratch/left.mp4", "/scratch/right.mp4") as { id: number };

      const accepted = await req(
        ctx.app,
        "POST",
        `/api/comparisons/${batch.id}/members/${member.id}/verdict`,
        { verdict: "prefer_left", note: "left keeps more detail" }
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.verdict).toBe("prefer_left");

      const after = await req(ctx.app, "GET", `/api/comparisons/${batch.id}`);
      expect(after.body.progress.preferLeft).toBe(1);
      expect(after.body.progress.pending).toBe(0);
    });

    it("can reset a verdict to null", async () => {
      const create = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [{ leftPath: "/a", rightPath: "/b" }],
      });
      const batchId = create.body.id;
      const get = await req(ctx.app, "GET", `/api/comparisons/${batchId}`);
      const id = get.body.members[0].id;

      await req(
        ctx.app,
        "POST",
        `/api/comparisons/${batchId}/members/${id}/verdict`,
        { verdict: "different" }
      );
      const reset = await req(
        ctx.app,
        "POST",
        `/api/comparisons/${batchId}/members/${id}/verdict`,
        { verdict: null }
      );
      expect(reset.body.verdict).toBe(null);
      expect(reset.body.verdictedAt).toBe(null);
    });

    it("rejects invalid verdicts", async () => {
      const create = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [{ leftPath: "/a", rightPath: "/b" }],
      });
      const get = await req(ctx.app, "GET", `/api/comparisons/${create.body.id}`);
      const res = await req(
        ctx.app,
        "POST",
        `/api/comparisons/${create.body.id}/members/${get.body.members[0].id}/verdict`,
        { verdict: "maybe" }
      );
      expect(res.status).toBe(400);
    });

    it("404s when member does not belong to the batch", async () => {
      const a = await req(ctx.app, "POST", "/api/comparisons", {
        name: "a",
        members: [{ leftPath: "/a", rightPath: "/b" }],
      });
      const b = await req(ctx.app, "POST", "/api/comparisons", {
        name: "b",
        members: [{ leftPath: "/c", rightPath: "/d" }],
      });
      const getA = await req(ctx.app, "GET", `/api/comparisons/${a.body.id}`);
      const aMemberId = getA.body.members[0].id;
      const res = await req(
        ctx.app,
        "POST",
        `/api/comparisons/${b.body.id}/members/${aMemberId}/verdict`,
        { verdict: "same" }
      );
      expect(res.status).toBe(404);
    });
  });

  describe("delete", () => {
    it("removes the batch and its members", async () => {
      const create = await req(ctx.app, "POST", "/api/comparisons", {
        name: "x",
        members: [
          { leftPath: "/a", rightPath: "/b" },
          { leftPath: "/c", rightPath: "/d" },
        ],
      });
      const id = create.body.id;
      const del = await req(ctx.app, "DELETE", `/api/comparisons/${id}`);
      expect(del.status).toBe(200);

      const get = await req(ctx.app, "GET", `/api/comparisons/${id}`);
      expect(get.status).toBe(404);

      // Members cascaded
      const remaining = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM comparison_members WHERE batch_id = ?`)
        .get(id) as { n: number };
      expect(remaining.n).toBe(0);
    });

    it("404s on unknown batch", async () => {
      const res = await req(ctx.app, "DELETE", "/api/comparisons/9999");
      expect(res.status).toBe(404);
    });
  });
});
