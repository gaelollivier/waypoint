import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { makeTestDb, insertDisk } from "../../helpers";
import { JobManager } from "../../../jobs/job-manager";
import { MediaMetadataJobRunner } from "../../../jobs/media-metadata/media-metadata-job";

/**
 * Builds a minimal JPEG with an EXIF APP1 segment (DateTimeOriginal, Make,
 * Model). Identical layout to the one in extractor.test.ts — duplicated
 * locally so the two test files don't depend on each other.
 */
function buildMinimalJpegWithExif(opts: {
  dateTimeOriginal: string;
  make: string;
  model: string;
}): Uint8Array {
  const enc = new TextEncoder();
  const dto = enc.encode(opts.dateTimeOriginal + "\0");
  const make = enc.encode(opts.make + "\0");
  const model = enc.encode(opts.model + "\0");

  const subIfdOffset = 0x32;
  const dataAreaStart = 0x44;
  const dtoOffset = dataAreaStart;
  const makeOffset = dtoOffset + dto.length;
  const modelOffset = makeOffset + make.length;
  const tiffSize = modelOffset + model.length;

  const tiff = new Uint8Array(tiffSize);
  const tv = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49;
  tv.setUint16(2, 0x002A, true);
  tv.setUint32(4, 0x00000008, true);

  let p = 0x08;
  tv.setUint16(p, 3, true); p += 2;
  tv.setUint16(p, 0x010F, true); p += 2;
  tv.setUint16(p, 2, true);       p += 2;
  tv.setUint32(p, make.length, true); p += 4;
  tv.setUint32(p, makeOffset, true);  p += 4;
  tv.setUint16(p, 0x0110, true); p += 2;
  tv.setUint16(p, 2, true);       p += 2;
  tv.setUint32(p, model.length, true); p += 4;
  tv.setUint32(p, modelOffset, true);  p += 4;
  tv.setUint16(p, 0x8769, true); p += 2;
  tv.setUint16(p, 4, true);       p += 2;
  tv.setUint32(p, 1, true);        p += 4;
  tv.setUint32(p, subIfdOffset, true); p += 4;
  tv.setUint32(p, 0, true); p += 4;

  p = subIfdOffset;
  tv.setUint16(p, 1, true); p += 2;
  tv.setUint16(p, 0x9003, true); p += 2;
  tv.setUint16(p, 2, true);       p += 2;
  tv.setUint32(p, dto.length, true); p += 4;
  tv.setUint32(p, dtoOffset, true);  p += 4;
  tv.setUint32(p, 0, true); p += 4;

  tiff.set(dto,   dtoOffset);
  tiff.set(make,  makeOffset);
  tiff.set(model, modelOffset);

  const app1Payload = new Uint8Array(6 + tiff.length);
  app1Payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
  app1Payload.set(tiff, 6);

  const app1Len = app1Payload.length + 2;
  const out = new Uint8Array(2 + 2 + 2 + app1Payload.length + 2);
  let o = 0;
  out[o++] = 0xFF; out[o++] = 0xD8;
  out[o++] = 0xFF; out[o++] = 0xE1;
  out[o++] = (app1Len >> 8) & 0xFF;
  out[o++] = app1Len & 0xFF;
  out.set(app1Payload, o); o += app1Payload.length;
  out[o++] = 0xFF; out[o++] = 0xD9;
  return out;
}

function insertScan(db: Database, diskId: number): number {
  const row = db
    .prepare(
      `INSERT INTO jobs (type, status, target_disk_id, created_by)
       VALUES ('scan', 'completed', ?, 'user') RETURNING id`
    )
    .get(diskId) as { id: number };
  return row.id;
}

function insertDirectory(db: Database, diskId: number, scanId: number, fullPath: string): number {
  const parts = fullPath.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  const row = db
    .prepare(
      `INSERT INTO directories
         (disk_id, scan_id, parent_id, name, path)
       VALUES (?, ?, ?, ?, ?) RETURNING id`
    )
    .get(diskId, scanId, null, name, fullPath) as { id: number };
  return row.id;
}

function insertFile(
  db: Database,
  diskId: number,
  scanId: number,
  dirId: number,
  fullPath: string,
  sizeBytes: number
): number {
  const name = fullPath.split("/").filter(Boolean).pop() ?? "";
  const row = db
    .prepare(
      `INSERT INTO files (disk_id, scan_id, directory_id, name, path, size_bytes, mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(diskId, scanId, dirId, name, fullPath, sizeBytes, "2024-01-01T00:00:00Z") as { id: number };
  return row.id;
}

describe("MediaMetadataJobRunner", () => {
  let db: Database;
  let jm: JobManager;
  let tmpDir: string;
  let diskId: number;
  let scanId: number;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    tmpDir = mkdtempSync(path.join(tmpdir(), "waypoint-mediameta-"));
    diskId = insertDisk(db, { mount_path: tmpDir, is_connected: 1 });
    scanId = insertScan(db, diskId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts EXIF for a real image file and stores it in media_metadata", async () => {
    const jpgBytes = buildMinimalJpegWithExif({
      dateTimeOriginal: "2020:06:15 14:30:00",
      make: "Acme",
      model: "Acme Cam 1",
    });
    const jpgPath = path.join(tmpDir, "photo.jpg");
    writeFileSync(jpgPath, jpgBytes);

    const dirId = insertDirectory(db, diskId, scanId, tmpDir);
    const fileId = insertFile(db, diskId, scanId, dirId, jpgPath, jpgBytes.length);

    const job = jm.createJob({ type: "media_metadata_extraction", targetDiskId: diskId });
    const runner = new MediaMetadataJobRunner({
      jobId: job.id, jobManager: jm, db, diskId, scanId,
    });
    await runner.start();

    const updated = jm.getJob(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.items_processed).toBe(1);

    const row = db
      .prepare(`SELECT * FROM media_metadata WHERE file_id = ?`)
      .get(fileId) as {
        datetime_original: string;
        datetime_source: string;
        make: string;
        model: string;
        captured_at_unix: number;
        extraction_error: string | null;
      };
    expect(row.make).toBe("Acme");
    expect(row.model).toBe("Acme Cam 1");
    expect(row.datetime_source).toBe("exif");
    expect(row.datetime_original).toBe(new Date("2020-06-15T14:30:00Z").toISOString());
    expect(row.captured_at_unix).toBe(Math.floor(new Date("2020-06-15T14:30:00Z").getTime() / 1000));
    expect(row.extraction_error).toBeNull();
  });

  it("records unsupported_extension for non-media files", async () => {
    const txtPath = path.join(tmpDir, "notes.txt");
    writeFileSync(txtPath, "hello");

    const dirId = insertDirectory(db, diskId, scanId, tmpDir);
    const fileId = insertFile(db, diskId, scanId, dirId, txtPath, 5);

    // findCandidates pre-filters by extension, so a .txt file is never even
    // enqueued. Verify that: no media_metadata row appears at all.
    const job = jm.createJob({ type: "media_metadata_extraction", targetDiskId: diskId });
    const runner = new MediaMetadataJobRunner({
      jobId: job.id, jobManager: jm, db, diskId, scanId,
    });
    await runner.start();

    const row = db.prepare(`SELECT * FROM media_metadata WHERE file_id = ?`).get(fileId);
    expect(row).toBeNull();
  });

  it("backfills duration_seconds on rows extracted before the column existed", async () => {
    // Simulate the migration-backfill case: an existing media_metadata row
    // for a video, written before duration_seconds was a column. The row
    // has datetime_source='quicktime' and duration_seconds=NULL. The job
    // should re-process this file.
    //
    // We use the JPG fixture (extractor returns durationSeconds=null for
    // images) but mark the row as datetime_source='quicktime' so the
    // backfill predicate matches. After the re-run we expect the row to be
    // updated (extracted_at changes) — duration stays null because the
    // extractor doesn't infer one for images.
    const jpgBytes = buildMinimalJpegWithExif({
      dateTimeOriginal: "2022:03:04 05:06:07",
      make: "FreshMake",
      model: "FreshModel",
    });
    const jpgPath = path.join(tmpDir, "video-shaped.jpg");
    writeFileSync(jpgPath, jpgBytes);
    const dirId = insertDirectory(db, diskId, scanId, tmpDir);
    const fileId = insertFile(db, diskId, scanId, dirId, jpgPath, jpgBytes.length);

    // Insert a stale row mimicking a pre-duration extraction. The make/model
    // here are intentionally wrong-looking — they'll be overwritten by the
    // re-extraction.
    db.prepare(
      `INSERT INTO media_metadata
         (file_id, datetime_original, datetime_source, captured_at_unix,
          make, model, duration_seconds, extracted_at)
       VALUES (?, '2099-01-01T00:00:00.000Z', 'quicktime', 999, 'Stale', 'Stale', NULL, '2024-01-01T00:00:00.000Z')`
    ).run(fileId);

    const job = jm.createJob({ type: "media_metadata_extraction", targetDiskId: diskId });
    const runner = new MediaMetadataJobRunner({
      jobId: job.id, jobManager: jm, db, diskId, scanId,
    });
    await runner.start();

    const updated = jm.getJob(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.items_processed).toBe(1);

    // The row was re-extracted: make/model now reflect the actual fixture.
    const row = db
      .prepare(`SELECT make, model, datetime_source FROM media_metadata WHERE file_id = ?`)
      .get(fileId) as { make: string; model: string; datetime_source: string };
    expect(row.make).toBe("FreshMake");
    expect(row.model).toBe("FreshModel");
    expect(row.datetime_source).toBe("exif");
  });

  it("does NOT re-extract images that already have a media_metadata row", async () => {
    // The backfill predicate (`datetime_source IN ('quicktime','none')`) must
    // not match `'exif'` rows — images written by the post-duration job are
    // correctly final even with duration_seconds=NULL.
    const jpgBytes = buildMinimalJpegWithExif({
      dateTimeOriginal: "2022:03:04 05:06:07",
      make: "Foo",
      model: "Bar",
    });
    const jpgPath = path.join(tmpDir, "already-done.jpg");
    writeFileSync(jpgPath, jpgBytes);
    const dirId = insertDirectory(db, diskId, scanId, tmpDir);
    const fileId = insertFile(db, diskId, scanId, dirId, jpgPath, jpgBytes.length);

    db.prepare(
      `INSERT INTO media_metadata
         (file_id, datetime_original, datetime_source, captured_at_unix,
          make, model, duration_seconds, extracted_at)
       VALUES (?, '2099-01-01T00:00:00.000Z', 'exif', 999, 'Keep', 'Me', NULL, '2024-01-01T00:00:00.000Z')`
    ).run(fileId);

    const job = jm.createJob({ type: "media_metadata_extraction", targetDiskId: diskId });
    const runner = new MediaMetadataJobRunner({
      jobId: job.id, jobManager: jm, db, diskId, scanId,
    });
    await runner.start();

    expect(jm.getJob(job.id)!.items_processed).toBe(0);
    const row = db
      .prepare(`SELECT make, model FROM media_metadata WHERE file_id = ?`)
      .get(fileId) as { make: string; model: string };
    expect(row.make).toBe("Keep");
  });

  it("skips files that already have a media_metadata row (idempotent re-run)", async () => {
    const jpgBytes = buildMinimalJpegWithExif({
      dateTimeOriginal: "2021:01:01 00:00:00",
      make: "X",
      model: "Y",
    });
    const jpgPath = path.join(tmpDir, "x.jpg");
    writeFileSync(jpgPath, jpgBytes);

    const dirId = insertDirectory(db, diskId, scanId, tmpDir);
    const fileId = insertFile(db, diskId, scanId, dirId, jpgPath, jpgBytes.length);

    // Pre-populate a media_metadata row for this file.
    db.prepare(
      `INSERT INTO media_metadata (file_id, datetime_original, datetime_source, make, model)
       VALUES (?, '2099-01-01T00:00:00.000Z', 'exif', 'Stale', 'Stale')`
    ).run(fileId);

    const job = jm.createJob({ type: "media_metadata_extraction", targetDiskId: diskId });
    const runner = new MediaMetadataJobRunner({
      jobId: job.id, jobManager: jm, db, diskId, scanId,
    });
    await runner.start();

    // Should have processed zero files (the only candidate is already in
    // media_metadata).
    const updated = jm.getJob(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.items_processed).toBe(0);

    // The stale row is unchanged.
    const row = db
      .prepare(`SELECT make, model FROM media_metadata WHERE file_id = ?`)
      .get(fileId) as { make: string; model: string };
    expect(row.make).toBe("Stale");
  });

  it("scopes extraction to pathPrefix when provided", async () => {
    const subdir = path.join(tmpDir, "sub");
    require("fs").mkdirSync(subdir);

    const jpgBytes = buildMinimalJpegWithExif({
      dateTimeOriginal: "2020:01:01 00:00:00",
      make: "M",
      model: "O",
    });
    const insideRoot   = path.join(tmpDir, "outside.jpg");
    const insidePrefix = path.join(subdir, "inside.jpg");
    writeFileSync(insideRoot, jpgBytes);
    writeFileSync(insidePrefix, jpgBytes);

    const rootDir = insertDirectory(db, diskId, scanId, tmpDir);
    const subDir  = insertDirectory(db, diskId, scanId, subdir);
    const idA = insertFile(db, diskId, scanId, rootDir, insideRoot,   jpgBytes.length);
    const idB = insertFile(db, diskId, scanId, subDir,  insidePrefix, jpgBytes.length);

    const job = jm.createJob({ type: "media_metadata_extraction", targetDiskId: diskId });
    const runner = new MediaMetadataJobRunner({
      jobId: job.id, jobManager: jm, db, diskId, scanId, pathPrefix: subdir,
    });
    await runner.start();

    const rows = db
      .prepare(`SELECT file_id FROM media_metadata ORDER BY file_id`)
      .all() as Array<{ file_id: number }>;
    expect(rows.map((r) => r.file_id)).toEqual([idB]);
    void idA;
  });
});
