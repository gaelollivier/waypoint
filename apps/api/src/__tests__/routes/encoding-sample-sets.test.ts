import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

const scratchRoots: string[] = [];
afterAll(() => {
  for (const r of scratchRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
function makeScratchRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "waypoint-encoding-sample-sets-route-"));
  scratchRoots.push(root);
  return root;
}

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

  describe("POST /:id/extract-frames", () => {
    it("returns 404 when the set does not exist", async () => {
      const r = await req(ctx.app, "POST", "/api/encoding-sample-sets/9999/extract-frames", {});
      expect(r.status).toBe(404);
    });

    it("refuses while a frame-extract job is already in flight", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });
      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/s",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });
      const setId = created.body.id;
      ctx.db
        .prepare(
          "INSERT INTO jobs (type, status, payload_json) VALUES ('encoding_frame_extract', 'running', ?)"
        )
        .run(JSON.stringify({ setId }));

      const r = await req(ctx.app, "POST", `/api/encoding-sample-sets/${setId}/extract-frames`, {});
      expect(r.status).toBe(409);
      expect(r.body.error).toContain("frame extraction already in flight");
    });

    it("refuses while the encoder is still running for the set", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });
      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/s",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });
      const setId = created.body.id;
      ctx.db
        .prepare(
          "INSERT INTO jobs (type, status, payload_json) VALUES ('encoding_sample_run', 'running', ?)"
        )
        .run(JSON.stringify({ setId }));

      const r = await req(ctx.app, "POST", `/api/encoding-sample-sets/${setId}/extract-frames`, {});
      expect(r.status).toBe(409);
      expect(r.body.error).toContain("encode run still in flight");
    });
  });

  describe("GET /:id/frames", () => {
    it("returns 404 when the set does not exist", async () => {
      const r = await req(ctx.app, "GET", "/api/encoding-sample-sets/9999/frames");
      expect(r.status).toBe(404);
    });

    it("returns frames ordered by sample → source-first → variant position", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });

      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/s",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });
      const setId = created.body.id;

      // Reach into the DB to seed frames directly so we don't have to run the
      // actual ffmpeg job.
      const sample = ctx.db
        .prepare(`SELECT id FROM encoding_samples WHERE set_id = ?`)
        .get(setId) as { id: number };
      const variant = ctx.db
        .prepare(`SELECT id FROM encoding_variants WHERE sample_id = ?`)
        .get(sample.id) as { id: number };

      ctx.db
        .prepare(
          `INSERT INTO encoding_frames (sample_id, variant_id, position, at_seconds, status)
           VALUES (?, NULL, ?, ?, ?)`
        )
        .run(sample.id, 0, 5, "done");
      ctx.db
        .prepare(
          `INSERT INTO encoding_frames (sample_id, variant_id, position, at_seconds, status)
           VALUES (?, NULL, ?, ?, ?)`
        )
        .run(sample.id, 1, 15, "pending");
      ctx.db
        .prepare(
          `INSERT INTO encoding_frames (sample_id, variant_id, position, at_seconds, status)
           VALUES (NULL, ?, ?, ?, ?)`
        )
        .run(variant.id, 0, 5, "pending");

      const r = await req(ctx.app, "GET", `/api/encoding-sample-sets/${setId}/frames`);
      expect(r.status).toBe(200);
      expect(r.body.frames).toHaveLength(3);
      // Source frames come before variant frames for the same sample.
      expect(r.body.frames[0].sampleId).toBe(sample.id);
      expect(r.body.frames[0].variantId).toBeNull();
      expect(r.body.frames[0].position).toBe(0);
      expect(r.body.frames[1].sampleId).toBe(sample.id);
      expect(r.body.frames[1].position).toBe(1);
      expect(r.body.frames[2].variantId).toBe(variant.id);
      expect(r.body.frames[2].sampleId).toBeNull();
      expect(r.body.frames[2].resolvedSampleId).toBe(sample.id);
    });
  });

  describe("POST /:id/frame-comparison-batches", () => {
    it("creates one encoding_frames comparison batch per ready sample", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });

      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/scratch",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [
          { codec: "hevc", encoder: "libx265", label: "v1" },
          { codec: "hevc", encoder: "libx265", label: "v2" },
          { codec: "av1", encoder: "libsvtav1", label: "v3" },
        ],
      });
      const setId = created.body.id;
      const sample = ctx.db
        .prepare(`SELECT id FROM encoding_samples WHERE set_id = ?`)
        .get(setId) as { id: number };
      const variants = ctx.db
        .prepare(`SELECT id FROM encoding_variants WHERE sample_id = ? ORDER BY position`)
        .all(sample.id) as Array<{ id: number }>;

      for (const [i, variant] of variants.entries()) {
        ctx.db
          .prepare(
            `UPDATE encoding_variants
                SET status = 'done',
                    output_path = ?,
                    output_size_bytes = ?
              WHERE id = ?`
          )
          .run(`/scratch/set-${setId}/sample-${sample.id}/variant-${variant.id}/variant-${variant.id}.mp4`, 1000 + i, variant.id);
      }
      for (let pos = 0; pos < 2; pos++) {
        ctx.db
          .prepare(
            `INSERT INTO encoding_frames
               (sample_id, variant_id, position, at_seconds, output_path, status)
             VALUES (?, NULL, ?, ?, ?, 'done')`
          )
          .run(sample.id, pos, 5 + pos * 10, `/scratch/set-${setId}/sample-${sample.id}/source/frame-${pos}.jpg`);
        for (const variant of variants) {
          ctx.db
            .prepare(
              `INSERT INTO encoding_frames
                 (sample_id, variant_id, position, at_seconds, output_path, status)
               VALUES (NULL, ?, ?, ?, ?, 'done')`
            )
            .run(
              variant.id,
              pos,
              5 + pos * 10,
              `/scratch/set-${setId}/sample-${sample.id}/variant-${variant.id}/frame-${pos}.jpg`
            );
        }
      }

      const res = await req(
        ctx.app,
        "POST",
        `/api/encoding-sample-sets/${setId}/frame-comparison-batches`,
        { namePrefix: "blind run" }
      );
      expect(res.status).toBe(201);
      expect(res.body.batches).toHaveLength(1);
      expect(res.body.batches[0].memberCount).toBe(6); // 3 choose 2 × 2 frames

      const detail = await req(ctx.app, "GET", `/api/comparisons/${res.body.batches[0].id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.kind).toBe("encoding_frames");
      expect(detail.body.sampleId).toBe(sample.id);
      expect(detail.body.members).toHaveLength(6);
      expect(detail.body.members.every((m: any) => m.left.path.endsWith(".jpg"))).toBe(true);
      expect(detail.body.members.every((m: any) => m.right.path.endsWith(".jpg"))).toBe(true);
      expect(detail.body.members.every((m: any) => m.encodingFrames.sourceFrames.length === 0)).toBe(true);
      expect(detail.body.members.every((m: any) => m.encodingFrames.leftFrames.length === 1)).toBe(true);
      expect(detail.body.members.every((m: any) => m.encodingFrames.rightFrames.length === 1)).toBe(true);
      const pairCounts = new Map<string, number>();
      for (const member of detail.body.members) {
        const pairKey = [member.left.variantId, member.right.variantId].sort((a, b) => a - b).join(":");
        pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
      }
      expect([...pairCounts.values()].sort()).toEqual([2, 2, 2]);
    });

    it("returns 409 when no sample has enough extracted frames", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });
      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/scratch",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });

      const res = await req(
        ctx.app,
        "POST",
        `/api/encoding-sample-sets/${created.body.id}/frame-comparison-batches`,
        {}
      );
      expect(res.status).toBe(409);
      expect(res.body.skipped[0].reason).toBe("fewer_than_two_ready_variants");
    });
  });

  describe("GET /:id/rankings", () => {
    it("returns 404 when the set does not exist", async () => {
      const r = await req(ctx.app, "GET", "/api/encoding-sample-sets/9999/rankings");
      expect(r.status).toBe(404);
    });

    it("ranks encoding variants from frame comparison verdicts", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });

      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "x",
        scratchRoot: "/scratch",
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [
          { codec: "hevc", encoder: "libx265", label: "v1" },
          { codec: "hevc", encoder: "libx265", label: "v2" },
          { codec: "av1", encoder: "libsvtav1", label: "v3" },
        ],
      });
      const setId = created.body.id;
      const sample = ctx.db
        .prepare(`SELECT id FROM encoding_samples WHERE set_id = ?`)
        .get(setId) as { id: number };
      const variants = ctx.db
        .prepare(`SELECT id FROM encoding_variants WHERE sample_id = ? ORDER BY position`)
        .all(sample.id) as Array<{ id: number }>;

      for (const [i, variant] of variants.entries()) {
        ctx.db
          .prepare(
            `UPDATE encoding_variants
                SET status = 'done',
                    output_path = ?,
                    output_size_bytes = ?,
                    encode_seconds = ?
              WHERE id = ?`
          )
          .run(
            `/scratch/set-${setId}/sample-${sample.id}/variant-${variant.id}/variant-${variant.id}.mp4`,
            1000 + i,
            10 + i,
            variant.id
          );
      }
      for (let pos = 0; pos < 2; pos++) {
        ctx.db
          .prepare(
            `INSERT INTO encoding_frames
               (sample_id, variant_id, position, at_seconds, output_path, status)
             VALUES (?, NULL, ?, ?, ?, 'done')`
          )
          .run(sample.id, pos, 5 + pos * 10, `/scratch/set-${setId}/sample-${sample.id}/source/frame-${pos}.jpg`);
        for (const variant of variants) {
          ctx.db
            .prepare(
              `INSERT INTO encoding_frames
                 (sample_id, variant_id, position, at_seconds, output_path, status)
               VALUES (NULL, ?, ?, ?, ?, 'done')`
            )
            .run(
              variant.id,
              pos,
              5 + pos * 10,
              `/scratch/set-${setId}/sample-${sample.id}/variant-${variant.id}/frame-${pos}.jpg`
            );
        }
      }

      const batch = await req(
        ctx.app,
        "POST",
        `/api/encoding-sample-sets/${setId}/frame-comparison-batches`,
        { framesPerVariantPair: 1 }
      );
      expect(batch.status).toBe(201);
      const batchId = batch.body.batches[0].id;
      const members = ctx.db
        .prepare(
          `SELECT id, left_variant_id, right_variant_id
             FROM comparison_members
            WHERE batch_id = ?
            ORDER BY position`
        )
        .all(batchId) as Array<{ id: number; left_variant_id: number; right_variant_id: number }>;
      expect(members).toHaveLength(3);

      const preferWinner = (a: number, b: number, winner: number) => {
        const member = members.find(
          (m) =>
            (m.left_variant_id === a && m.right_variant_id === b) ||
            (m.left_variant_id === b && m.right_variant_id === a)
        );
        expect(member).toBeDefined();
        if (member === undefined) {
          throw new Error("invariant: expected comparison member for variant pair");
        }
        const verdict = member.left_variant_id === winner ? "prefer_left" : "prefer_right";
        ctx.db
          .prepare(`UPDATE comparison_members SET verdict = ? WHERE id = ?`)
          .run(verdict, member.id);
      };

      preferWinner(variants[0].id, variants[1].id, variants[0].id);
      preferWinner(variants[0].id, variants[2].id, variants[0].id);
      preferWinner(variants[1].id, variants[2].id, variants[2].id);

      const rankings = await req(ctx.app, "GET", `/api/encoding-sample-sets/${setId}/rankings`);
      expect(rankings.status).toBe(200);
      expect(rankings.body.set.scratchRoot).toBeUndefined();
      expect(rankings.body.samples).toHaveLength(1);
      expect(rankings.body.samples[0].comparisons.total).toBe(3);
      expect(rankings.body.samples[0].variants.map((v: any) => v.variantId)).toEqual([
        variants[0].id,
        variants[2].id,
        variants[1].id,
      ]);
      expect(rankings.body.samples[0].variants.map((v: any) => v.score)).toEqual([2, 1, 0]);
      expect(rankings.body.aggregate.variants.map((v: any) => v.position)).toEqual([0, 2, 1]);
      expect(JSON.stringify(rankings.body)).not.toContain("/scratch/");
    });
  });

  describe("DELETE /:id/scratch?framesOnly=true", () => {
    it("removes frame JPEGs and resets frame rows without touching variants", async () => {
      const scratchRoot = makeScratchRoot();
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });
      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "frames-only",
        scratchRoot,
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [{ codec: "hevc", encoder: "libx265", label: "v1" }],
      });
      const setId = created.body.id;
      const sample = ctx.db
        .prepare(`SELECT id FROM encoding_samples WHERE set_id = ?`)
        .get(setId) as { id: number };
      const variant = ctx.db
        .prepare(`SELECT id FROM encoding_variants WHERE sample_id = ?`)
        .get(sample.id) as { id: number };

      const variantDir = path.join(scratchRoot, `set-${setId}`, `sample-${sample.id}`);
      const variantFile = path.join(variantDir, `variant-${variant.id}.mp4`);
      const sourceFrameDir = path.join(variantDir, "source");
      const sourceFrame = path.join(sourceFrameDir, "frame-0.jpg");
      const variantFrameDir = path.join(variantDir, `variant-${variant.id}`);
      const variantFrame = path.join(variantFrameDir, "frame-0.jpg");
      mkdirSync(sourceFrameDir, { recursive: true });
      mkdirSync(variantFrameDir, { recursive: true });
      writeFileSync(variantFile, "mp4-bytes");
      writeFileSync(sourceFrame, "jpeg-src");
      writeFileSync(variantFrame, "jpeg-var");

      ctx.db
        .prepare(
          `UPDATE encoding_variants
              SET status = 'done', output_path = ?, output_size_bytes = ?
            WHERE id = ?`
        )
        .run(variantFile, 9, variant.id);
      ctx.db
        .prepare(
          `INSERT INTO encoding_frames
             (sample_id, variant_id, position, at_seconds, output_path, status)
           VALUES (?, NULL, 0, 5, ?, 'done')`
        )
        .run(sample.id, sourceFrame);
      ctx.db
        .prepare(
          `INSERT INTO encoding_frames
             (sample_id, variant_id, position, at_seconds, output_path, status)
           VALUES (NULL, ?, 0, 5, ?, 'done')`
        )
        .run(variant.id, variantFrame);

      const res = await req(
        ctx.app,
        "DELETE",
        `/api/encoding-sample-sets/${setId}/scratch?framesOnly=true`
      );
      expect(res.status).toBe(200);
      expect(res.body.framesOnly).toBe(true);
      expect(res.body.deletedFiles).toBe(2);
      expect(res.body.errors).toEqual([]);

      // Variant MP4 + DB row are preserved.
      expect(existsSync(variantFile)).toBe(true);
      const variantRow = ctx.db
        .prepare(`SELECT status, output_path, output_size_bytes FROM encoding_variants WHERE id = ?`)
        .get(variant.id) as { status: string; output_path: string; output_size_bytes: number };
      expect(variantRow.status).toBe("done");
      expect(variantRow.output_path).toBe(variantFile);
      expect(variantRow.output_size_bytes).toBe(9);

      // Frame JPEGs are gone; rows are reset to pending with NULL output_path.
      expect(existsSync(sourceFrame)).toBe(false);
      expect(existsSync(variantFrame)).toBe(false);
      const frameRows = ctx.db
        .prepare(`SELECT status, output_path FROM encoding_frames ORDER BY id`)
        .all() as Array<{ status: string; output_path: string | null }>;
      expect(frameRows).toEqual([
        { status: "pending", output_path: null },
        { status: "pending", output_path: null },
      ]);

      // The sample directory itself still exists because the variant MP4 is still in it.
      expect(existsSync(variantDir)).toBe(true);

      // Audit log: frame-delete entries only, no variant-delete entries.
      const actions = (ctx.db
        .prepare(`SELECT action FROM audit_log WHERE action LIKE 'encoding_%scratch_delete'`)
        .all() as Array<{ action: string }>).map((r) => r.action);
      expect(actions.filter((a) => a === "encoding_frame_scratch_delete")).toHaveLength(2);
      expect(actions.filter((a) => a === "encoding_variant_scratch_delete")).toHaveLength(0);
    });

    it("idempotently resets rows whose JPEG was already gone (no error)", async () => {
      const scratchRoot = makeScratchRoot();
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertFile(ctx, { diskId, scanId, path: "/a.mp4", size: 100, duration: 60 });
      const created = await req(ctx.app, "POST", "/api/encoding-sample-sets", {
        name: "frames-missing",
        scratchRoot,
        samples: [{ sourceDiskId: diskId, sourcePath: "/a.mp4", clipDurationSeconds: 30 }],
        variants: [{ codec: "hevc", encoder: "libx265" }],
      });
      const setId = created.body.id;
      const sample = ctx.db
        .prepare(`SELECT id FROM encoding_samples WHERE set_id = ?`)
        .get(setId) as { id: number };
      const variant = ctx.db
        .prepare(`SELECT id FROM encoding_variants WHERE sample_id = ?`)
        .get(sample.id) as { id: number };

      // Mark variant done but never create the file; mark a frame done with a
      // path that doesn't exist on disk. This is the state after an
      // interrupted extract where ffmpeg exited 0 without producing output.
      const stalePath = path.join(
        scratchRoot, `set-${setId}`, `sample-${sample.id}`, `variant-${variant.id}`, "frame-0.jpg"
      );
      ctx.db
        .prepare(`UPDATE encoding_variants SET status='done', output_path=? WHERE id=?`)
        .run(path.join(scratchRoot, `set-${setId}`, `sample-${sample.id}`, `variant-${variant.id}.mp4`), variant.id);
      ctx.db
        .prepare(
          `INSERT INTO encoding_frames (sample_id, variant_id, position, at_seconds, output_path, status)
           VALUES (NULL, ?, 0, 5, ?, 'done')`
        )
        .run(variant.id, stalePath);

      const res = await req(
        ctx.app, "DELETE", `/api/encoding-sample-sets/${setId}/scratch?framesOnly=true`
      );
      expect(res.status).toBe(200);
      expect(res.body.deletedFiles).toBe(0);
      expect(res.body.errors).toEqual([]);

      const row = ctx.db
        .prepare(`SELECT status, output_path FROM encoding_frames`)
        .get() as { status: string; output_path: string | null };
      expect(row.status).toBe("pending");
      expect(row.output_path).toBeNull();

      const audit = ctx.db
        .prepare(`SELECT metadata_json FROM audit_log WHERE action = 'encoding_frame_scratch_delete'`)
        .get() as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ fileMissing: true });
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
