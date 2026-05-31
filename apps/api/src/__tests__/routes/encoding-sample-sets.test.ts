import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

function setupScannedDisk(ctx: TestContext): { diskId: number; scanId: number } {
  const diskId = insertDisk(ctx.db);
  const scanId = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
  ctx.db.prepare("UPDATE disks SET last_scan_job_id = ? WHERE id = ?").run(scanId, diskId);
  return { diskId, scanId };
}

function insertFile(
  ctx: TestContext,
  args: { diskId: number; scanId: number; path: string; size: number; duration?: number; make?: string }
): number {
  ctx.db
    .prepare(
      `INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
    .run(1, args.diskId, args.scanId, null, "root", "/");
  const name = args.path.split("/").pop() ?? args.path;
  const f = ctx.db
    .prepare(
      `INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, hash_algo_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(args.diskId, args.scanId, 1, name, args.path, args.size, "2024-01-01", 1) as { id: number };
  if (args.duration !== undefined) {
    ctx.db
      .prepare(
        `INSERT INTO media_metadata (file_id, duration_seconds, make, captured_at_unix)
         VALUES (?, ?, ?, ?)`
      )
      .run(f.id, args.duration, args.make ?? null, 1700000000);
  }
  return f.id;
}

describe("encoding-sample-sets", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  it("rejects missing required fields", async () => {
    const r = await req(ctx.app, "POST", "/api/encoding-sample-sets", {});
    expect(r.status).toBe(400);
  });

  it("rejects samples whose source file isn't in the latest scan", async () => {
    const { diskId } = setupScannedDisk(ctx);
    const r = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
      name: "test",
      scratchRoot: "/scratch",
      samples: [{ sourceDiskId: diskId, sourcePath: "/nope.mp4" }],
      variants: [{ codec: "hevc", encoder: "libx265", preset: "medium", crf: 26 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("file not found");
  });

  it("creates a sample set with matrix of pending variants", async () => {
    const { diskId, scanId } = setupScannedDisk(ctx);
    insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60, make: "Apple" });
    insertFile(ctx, { diskId, scanId, path: "/b.mp4", size: 200, duration: 120 });

    const r = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
      name: "first run",
      notes: "hevc + av1 sweep",
      scratchRoot: "/Volumes/T7_Shield/.waypoint-encoding-scratch",
      samples: [
        { sourceDiskId: diskId, sourcePath: "/a.mp4", clipStartSeconds: 5, clipDurationSeconds: 60, label: "iPhone" },
        { sourceDiskId: diskId, sourcePath: "/b.mp4", label: "GoPro" },
      ],
      variants: [
        { codec: "hevc", encoder: "libx265", preset: "medium", crf: 26, label: "x265 medium 26" },
        { codec: "av1", encoder: "libsvtav1", preset: "6", crf: 28, label: "svtav1 p6 28" },
      ],
    });
    expect(r.status).toBe(201);
    const setId = r.body.id;

    const detail = await req(ctx.app, "GET", `/api/encoding-sample-sets/${setId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.set.name).toBe("first run");
    expect(detail.body.samples).toHaveLength(2);
    expect(detail.body.variants).toHaveLength(4); // 2 samples × 2 variants
    expect(detail.body.samples[0].label).toBe("iPhone");
    expect(detail.body.samples[0].sourceSizeBytes).toBe(100);
    expect(detail.body.samples[0].sourceDurationSeconds).toBe(60);
    expect(detail.body.samples[0].sourceMake).toBe("Apple");
    expect(detail.body.variants[0].status).toBe("pending");
    expect(detail.body.variants[0].codec).toBe("hevc");
    expect(detail.body.variants[1].codec).toBe("av1");
  });

  it("logs an audit entry on create and on delete", async () => {
    const { diskId, scanId } = setupScannedDisk(ctx);
    insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100 });

    const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
      name: "x",
      scratchRoot: "/s",
      samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4" }],
      variants: [{ codec: "hevc", encoder: "libx265", preset: "medium", crf: 26 }],
    });
    expect(created.status).toBe(201);
    const setId = created.body.id;

    const audit = ctx.db
      .prepare("SELECT action, after_json FROM audit_log WHERE action LIKE 'encoding_sample_set_%' ORDER BY id")
      .all() as Array<{ action: string; after_json: string | null }>;
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("encoding_sample_set_create");
    expect(JSON.parse(audit[0].after_json ?? "{}").sampleCount).toBe(1);

    await req(ctx.app, "DELETE", `/api/encoding-sample-sets/${setId}`);
    const audit2 = ctx.db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'encoding_sample_set_%' ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(audit2.map((r) => r.action)).toEqual([
      "encoding_sample_set_create",
      "encoding_sample_set_delete",
    ]);
  });

  describe("POST /:id/run", () => {
    it("returns 404 when the set does not exist", async () => {
      const r = await req(ctx.app, "POST", "/api/encoding-sample-sets/9999/run", {});
      expect(r.status).toBe(404);
    });

    it("rejects concurrent runs on the same set", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100 });

      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/s",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4" }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });
      const setId = created.body.id;

      ctx.db
        .prepare(
          "INSERT INTO jobs (type, status, payload_json) VALUES ('encoding_sample_run', 'running', ?)"
        )
        .run(JSON.stringify({ setId }));

      const r = await req(ctx.app, "POST", `/api/encoding-sample-sets/${setId}/run`, {});
      expect(r.status).toBe(409);
      expect(r.body.error).toContain("already in flight");
    });
  });

  it("lists sample sets newest first", async () => {
    const { diskId, scanId } = setupScannedDisk(ctx);
    insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100 });

    for (const name of ["first", "second", "third"]) {
      await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name,
        scratchRoot: "/s",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4" }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });
    }
    const r = await req(ctx.app, "GET", "/api/encoding-sample-sets");
    expect(r.status).toBe(200);
    expect(r.body.sets.map((s: any) => s.name)).toEqual(["third", "second", "first"]);
  });
});
