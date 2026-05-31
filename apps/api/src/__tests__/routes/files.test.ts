import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp, req, insertDisk, type TestContext } from "./helpers";
import { insertJob } from "../helpers";

function setupScannedDisk(ctx: TestContext, label?: string): { diskId: number; scanId: number } {
  const diskId = insertDisk(ctx.db, { label: label ?? undefined });
  const scanId = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
  ctx.db.prepare("UPDATE disks SET last_scan_job_id = ? WHERE id = ?").run(scanId, diskId);
  return { diskId, scanId };
}

function insertDir(
  ctx: TestContext,
  args: {
    id: number;
    diskId: number;
    scanId: number;
    parentId: number | null;
    name: string;
    path: string;
    totalSize?: number;
    fileCount?: number;
    directFileCount?: number;
  }
): void {
  ctx.db
    .prepare(
      "INSERT INTO directories (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      args.id,
      args.diskId,
      args.scanId,
      args.parentId,
      args.name,
      args.path,
      args.totalSize ?? 0,
      args.fileCount ?? 0,
      args.directFileCount ?? 0
    );
}

function insertFile(
  ctx: TestContext,
  args: {
    diskId: number;
    scanId: number;
    directoryId: number;
    name: string;
    path: string;
    size: number;
    mtime?: string;
    sampledHash?: string | null;
    fullHash?: string | null;
  }
): number {
  const result = ctx.db
    .prepare(
      "INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    )
    .get(
      args.diskId,
      args.scanId,
      args.directoryId,
      args.name,
      args.path,
      args.size,
      args.mtime ?? "2024-01-01",
      args.sampledHash ?? null,
      args.fullHash ?? null,
      1
    ) as { id: number };
  return result.id;
}

function insertMedia(
  ctx: TestContext,
  fileId: number,
  args: {
    capturedAt?: number | null;
    duration?: number | null;
    make?: string | null;
    model?: string | null;
    datetimeOriginal?: string | null;
    datetimeSource?: string | null;
  }
): void {
  ctx.db
    .prepare(
      "INSERT INTO media_metadata (file_id, captured_at_unix, duration_seconds, make, model, datetime_original, datetime_source) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      fileId,
      args.capturedAt ?? null,
      args.duration ?? null,
      args.make ?? null,
      args.model ?? null,
      args.datetimeOriginal ?? null,
      args.datetimeSource ?? null
    );
}

describe("agent query routes", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestApp();
  });

  // ───────────────────── /api/disks/:id/files ─────────────────────────────

  describe("GET /api/disks/:id/files", () => {
    it("returns 404 for a non-existent disk", async () => {
      const res = await req(ctx.app, "GET", "/api/disks/9999/files");
      expect(res.status).toBe(404);
    });

    it("returns 400 when disk has no scans", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Disk has no scans");
    });

    it("returns files for the latest scan by default, sorted by id asc", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "root", path: "/r" });
      const a = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "a.txt", path: "/r/a.txt", size: 10 });
      const b = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "b.txt", path: "/r/b.txt", size: 20 });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files`);
      expect(res.status).toBe(200);
      expect(res.body.diskId).toBe(diskId);
      expect(res.body.scanId).toBe(scanId);
      expect(res.body.entries.map((e: any) => e.id)).toEqual([a, b]);
      expect(res.body.truncated).toBe(false);
      expect(res.body.nextCursor).toBeNull();
    });

    it("filters by pathPrefix", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "root", path: "/r" });
      insertDir(ctx, { id: 101, diskId, scanId, parentId: 100, name: "sub", path: "/r/sub" });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "a.txt", path: "/r/a.txt", size: 1 });
      insertFile(ctx, { diskId, scanId, directoryId: 101, name: "b.txt", path: "/r/sub/b.txt", size: 2 });
      insertFile(ctx, { diskId, scanId, directoryId: 101, name: "c.txt", path: "/r/sub/c.txt", size: 3 });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files?pathPrefix=/r/sub`);
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: any) => e.name).sort()).toEqual(["b.txt", "c.txt"]);
    });

    it("filters by ext (single and multi)", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "a.mp4", path: "/r/a.mp4", size: 1 });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "b.jpg", path: "/r/b.jpg", size: 1 });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "c.mov", path: "/r/c.mov", size: 1 });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files?ext=mp4,mov`);
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: any) => e.name).sort()).toEqual(["a.mp4", "c.mov"]);
    });

    it("filters by size range and sorts size desc by default", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "small", path: "/r/small", size: 50 });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "mid", path: "/r/mid", size: 500 });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "big", path: "/r/big", size: 5000 });

      const res = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/files?sizeMin=100&sort=size`
      );
      expect(res.status).toBe(200);
      // sort=size defaults to desc; sizeMin=100 excludes the 50-byte file
      expect(res.body.entries.map((e: any) => e.name)).toEqual(["big", "mid"]);
    });

    it("filters by sampledHash", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "a", path: "/r/a", size: 1, sampledHash: "deadbeef" });
      insertFile(ctx, { diskId, scanId, directoryId: 100, name: "b", path: "/r/b", size: 1, sampledHash: "feedface" });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files?sampledHash=deadbeef`);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].name).toBe("a");
    });

    it("filters by capturedAt range when media join is needed", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      const a = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "old", path: "/r/old", size: 1 });
      const b = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "new", path: "/r/new", size: 1 });
      const c = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "naked", path: "/r/naked", size: 1 });
      insertMedia(ctx, a, { capturedAt: 1000 });
      insertMedia(ctx, b, { capturedAt: 2000 });
      // c has no metadata row

      const res = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/files?capturedFrom=1500&capturedTo=2500`
      );
      expect(res.body.entries.map((e: any) => e.name)).toEqual(["new"]);
    });

    it("opt-in include=media returns the media subobject", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      const a = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "a", path: "/r/a", size: 1 });
      insertMedia(ctx, a, { capturedAt: 1234, make: "apple", model: "iphone" });

      const r1 = await req(ctx.app, "GET", `/api/disks/${diskId}/files`);
      expect(r1.body.entries[0].media).toBeUndefined();

      const r2 = await req(ctx.app, "GET", `/api/disks/${diskId}/files?include=media`);
      expect(r2.body.entries[0].media).toEqual({
        capturedAtUnix: 1234,
        datetimeOriginal: null,
        datetimeSource: null,
        durationSeconds: null,
        make: "apple",
        model: "iphone",
      });
    });

    it("paginates with a cursor when more rows exist than limit", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      for (let i = 0; i < 5; i++) {
        insertFile(ctx, {
          diskId,
          scanId,
          directoryId: 100,
          name: `f${i}`,
          path: `/r/f${i}`,
          size: i + 1,
        });
      }

      const r1 = await req(ctx.app, "GET", `/api/disks/${diskId}/files?limit=2`);
      expect(r1.body.entries).toHaveLength(2);
      expect(r1.body.truncated).toBe(true);
      expect(r1.body.nextCursor).toBeTruthy();

      const r2 = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/files?limit=2&cursor=${encodeURIComponent(r1.body.nextCursor)}`
      );
      expect(r2.body.entries).toHaveLength(2);
      expect(r2.body.truncated).toBe(true);

      const r3 = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/files?limit=2&cursor=${encodeURIComponent(r2.body.nextCursor)}`
      );
      expect(r3.body.entries).toHaveLength(1);
      expect(r3.body.truncated).toBe(false);
      expect(r3.body.nextCursor).toBeNull();

      // Stitch all three pages together; should be exactly the five rows.
      const allIds = [
        ...r1.body.entries.map((e: any) => e.id),
        ...r2.body.entries.map((e: any) => e.id),
        ...r3.body.entries.map((e: any) => e.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    });

    it("rejects unknown sort keys", async () => {
      const { diskId } = setupScannedDisk(ctx);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files?sort=bogus`);
      expect(res.status).toBe(400);
    });
  });

  // ───────────────────── /api/disks/:id/files/by-path ─────────────────────

  describe("GET /api/disks/:id/files/by-path", () => {
    it("returns the file with media when include=media", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      const a = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "a.jpg", path: "/r/a.jpg", size: 99 });
      insertMedia(ctx, a, { capturedAt: 42, make: "canon" });

      const res = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/files/by-path?path=/r/a.jpg&include=media`
      );
      expect(res.status).toBe(200);
      expect(res.body.file.id).toBe(a);
      expect(res.body.file.media.capturedAtUnix).toBe(42);
    });

    it("returns 404 for an unknown path", async () => {
      const { diskId } = setupScannedDisk(ctx);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files/by-path?path=/nope`);
      expect(res.status).toBe(404);
    });

    it("returns 400 when path is missing", async () => {
      const { diskId } = setupScannedDisk(ctx);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files/by-path`);
      expect(res.status).toBe(400);
    });
  });

  // ───────────────────── /api/disks/:id/files/:fileId ─────────────────────

  describe("GET /api/disks/:id/files/:fileId", () => {
    it("returns the file by id", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      const a = insertFile(ctx, { diskId, scanId, directoryId: 100, name: "x", path: "/r/x", size: 1 });
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files/${a}`);
      expect(res.status).toBe(200);
      expect(res.body.file.id).toBe(a);
    });

    it("returns 404 when the file id is not on this disk", async () => {
      const { diskId } = setupScannedDisk(ctx);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/files/9999`);
      expect(res.status).toBe(404);
    });
  });

  // ───────────────────── /api/disks/:id/directories ───────────────────────

  describe("GET /api/disks/:id/directories", () => {
    it("returns directories sorted by id asc by default", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertDir(ctx, { id: 101, diskId, scanId, parentId: 100, name: "a", path: "/r/a", totalSize: 5 });
      insertDir(ctx, { id: 102, diskId, scanId, parentId: 100, name: "b", path: "/r/b", totalSize: 10 });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/directories`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(3);
    });

    it("filters by parentPath", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertDir(ctx, { id: 101, diskId, scanId, parentId: 100, name: "year", path: "/r/year" });
      insertDir(ctx, { id: 102, diskId, scanId, parentId: 101, name: "famille", path: "/r/year/famille" });
      insertDir(ctx, { id: 103, diskId, scanId, parentId: 101, name: "trip", path: "/r/year/trip" });

      const res = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/directories?parentPath=/r/year`
      );
      expect(res.body.entries.map((e: any) => e.name).sort()).toEqual(["famille", "trip"]);
    });

    it("filters by depth relative to disk root", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertDir(ctx, { id: 101, diskId, scanId, parentId: 100, name: "a", path: "/r/a" });
      insertDir(ctx, { id: 102, diskId, scanId, parentId: 101, name: "b", path: "/r/a/b" });

      // depth=1 means only direct children of root.
      const res = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/directories?minDepth=1&maxDepth=1`
      );
      expect(res.body.entries.map((e: any) => e.name)).toEqual(["a"]);
    });

    it("sorts by size desc when sort=size", async () => {
      const { diskId, scanId } = setupScannedDisk(ctx);
      insertDir(ctx, { id: 100, diskId, scanId, parentId: null, name: "r", path: "/r" });
      insertDir(ctx, { id: 101, diskId, scanId, parentId: 100, name: "small", path: "/r/small", totalSize: 100 });
      insertDir(ctx, { id: 102, diskId, scanId, parentId: 100, name: "big", path: "/r/big", totalSize: 5000 });
      insertDir(ctx, { id: 103, diskId, scanId, parentId: 100, name: "mid", path: "/r/mid", totalSize: 1000 });

      const res = await req(
        ctx.app,
        "GET",
        `/api/disks/${diskId}/directories?sort=size&minDepth=1`
      );
      // depth=1 strips the root, leaving the three children sorted by size desc
      expect(res.body.entries.map((e: any) => e.name)).toEqual(["big", "mid", "small"]);
    });
  });

  // ───────────────────── /api/disks/:id/scans ─────────────────────────────

  describe("GET /api/disks/:id/scans", () => {
    it("returns an empty list and null latest for a disk with no scans", async () => {
      const diskId = insertDisk(ctx.db);
      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/scans`);
      expect(res.status).toBe(200);
      expect(res.body.diskId).toBe(diskId);
      expect(res.body.latestScanId).toBeNull();
      expect(res.body.scans).toEqual([]);
    });

    it("returns scans newest first with file counts", async () => {
      const diskId = insertDisk(ctx.db);
      const scan1 = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
      const scan2 = insertJob(ctx.db, { type: "scan", status: "completed", target_disk_id: diskId });
      ctx.db.prepare("UPDATE disks SET last_scan_job_id = ? WHERE id = ?").run(scan2, diskId);

      insertDir(ctx, { id: 100, diskId, scanId: scan1, parentId: null, name: "r", path: "/r" });
      insertFile(ctx, { diskId, scanId: scan1, directoryId: 100, name: "a", path: "/r/a", size: 5, sampledHash: "h1" });
      insertDir(ctx, { id: 200, diskId, scanId: scan2, parentId: null, name: "r", path: "/r" });
      insertFile(ctx, { diskId, scanId: scan2, directoryId: 200, name: "a", path: "/r/a", size: 5, sampledHash: "h1", fullHash: "f1" });
      insertFile(ctx, { diskId, scanId: scan2, directoryId: 200, name: "b", path: "/r/b", size: 7, sampledHash: "h2", fullHash: "f2" });

      const res = await req(ctx.app, "GET", `/api/disks/${diskId}/scans`);
      expect(res.status).toBe(200);
      expect(res.body.latestScanId).toBe(scan2);
      expect(res.body.scans.map((s: any) => s.id)).toEqual([scan2, scan1]);

      const s2 = res.body.scans.find((s: any) => s.id === scan2);
      expect(s2.fileCount).toBe(2);
      expect(s2.totalSizeBytes).toBe(12);
      expect(s2.sampledHashCount).toBe(2);
      expect(s2.fullHashCount).toBe(2);
    });
  });
});
