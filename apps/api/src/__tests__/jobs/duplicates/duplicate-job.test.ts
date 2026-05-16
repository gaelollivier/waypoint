import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { JobManager } from "../../../jobs/job-manager";
import { ScanJobRunner } from "../../../jobs/scan/scan-job";
import { DuplicateDetectionJobRunner } from "../../../jobs/duplicates/duplicate-job";
import { deleteDuplicateFile } from "../../../fs/disk-writes";
import { computeFullHashStreaming, computeSampledHash } from "../../../jobs/scan/hasher";
import { makeTestDb, insertDisk } from "../../helpers";
import { EXCLUDED_NAMES_SQL } from "../../../lib/excluded-names";

const TMP_BASE = "/tmp/waypoint-duplicate-test";

beforeAll(() => mkdirSync(TMP_BASE, { recursive: true }));
afterAll(() => rmSync(TMP_BASE, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function scanDisk(
  db: Database,
  jm: JobManager,
  diskId: number,
  mountPath: string
): Promise<void> {
  const job = jm.createJob({ type: "scan", targetDiskId: diskId });
  db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(mountPath, diskId);
  const runner = new ScanJobRunner({ jobId: job.id, jobManager: jm, db, diskId, mountPath });
  await runner.start();
}

async function runDuplicateDetection(
  db: Database,
  jm: JobManager,
  diskId: number
): Promise<number> {
  const scan = db.prepare("SELECT last_scan_job_id FROM disks WHERE id = ?").get(diskId) as { last_scan_job_id: number };
  const job = jm.createJob({ type: "duplicate_detection", targetDiskId: diskId, payload: { scanId: scan.last_scan_job_id } });
  const runner = new DuplicateDetectionJobRunner({ jobId: job.id, jobManager: jm, db, diskId, scanId: scan.last_scan_job_id });
  await runner.start();
  return job.id;
}

type DuplicateGroupRow = {
  id: number;
  duplicate_job_id: number;
  hash_kind: "full" | "sampled";
  content_hash: string;
  sampled_hash: string;
  file_count: number;
  size_bytes: number;
  wasted_bytes: number;
};

function getGroups(db: Database, jobId: number): DuplicateGroupRow[] {
  return db
    .prepare("SELECT * FROM duplicate_groups WHERE duplicate_job_id = ? ORDER BY wasted_bytes DESC")
    .all(jobId) as DuplicateGroupRow[];
}

function getGroupFiles(db: Database, groupId: number): Array<{ file_id: number; path: string }> {
  return db
    .prepare("SELECT file_id, path FROM duplicate_group_files WHERE group_id = ? ORDER BY path")
    .all(groupId) as Array<{ file_id: number; path: string }>;
}


async function makeDeleteProof(deletePath: string, keepPath: string) {
  const [deleteFullHash, keepFullHash] = await Promise.all([
    computeFullHashStreaming(deletePath),
    computeFullHashStreaming(keepPath),
  ]);
  const [deleteActualSampledHash, keepActualSampledHash] = await Promise.all([
    computeSampledHash(deletePath, 17),
    computeSampledHash(keepPath, 17),
  ]);
  return {
    expectedFullHash: keepFullHash,
    deleteFullHash,
    keepFullHash,
    deleteExpectedSampledHash: deleteActualSampledHash,
    keepExpectedSampledHash: keepActualSampledHash,
    deleteActualSampledHash,
    keepActualSampledHash,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DuplicateDetectionJobRunner", () => {
  let db: Database;
  let jm: JobManager;
  let diskId: number;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    diskId = insertDisk(db, { mount_path: "/tmp/waypoint-duplicate-test/disk-a" });
  });


  it("uses dedicated indexes for hot member lookups", () => {
    const fullPlan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, path
       FROM files
       WHERE scan_id = ?
         AND full_hash = ?
         AND size_bytes = ?
         AND ${EXCLUDED_NAMES_SQL}`
    ).all(1, "full", 100) as Array<{ detail: string }>;

    const sampledPlan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, path
       FROM files
       WHERE scan_id = ?
         AND full_hash IS NULL
         AND sampled_hash = ?
         AND size_bytes = ?
         AND ${EXCLUDED_NAMES_SQL}`
    ).all(1, "sampled", 100) as Array<{ detail: string }>;

    expect(fullPlan.some((row) => row.detail.includes("files_scan_full_hash_size"))).toBe(true);
    expect(sampledPlan.some((row) => row.detail.includes("files_scan_sampled_only_hash_size"))).toBe(true);
  });

  it("finds real duplicates (identical content at different paths)", async () => {
    const root = path.join(TMP_BASE, "real-dupes");
    writeTree(root, {
      "photos/vacation.jpg": "same content here",
      "backup/vacation.jpg": "same content here",
      "unique.txt": "only one copy",
    });
    await scanDisk(db, jm, diskId, root);

    const jobId = await runDuplicateDetection(db, jm, diskId);
    const groups = getGroups(db, jobId);

    // Should find exactly one duplicate group (vacation.jpg × 2)
    expect(groups.length).toBe(1);
    expect(groups[0].file_count).toBe(2);

    const files = getGroupFiles(db, groups[0].id);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.path.includes("vacation.jpg"))).toBe(true);
  });


  it("prefers full-hash evidence when available", async () => {
    const root = path.join(TMP_BASE, "full-hash-dupes");
    writeTree(root, {
      "a.txt": "same content",
      "b.txt": "same content",
    });

    const scanJob = jm.createJob({ type: "scan", targetDiskId: diskId, payload: { fullHash: true } });
    db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
    const scanRunner = new ScanJobRunner({
      jobId: scanJob.id,
      jobManager: jm,
      db,
      diskId,
      mountPath: root,
      fullHash: true,
    });
    await scanRunner.start();

    const jobId = await runDuplicateDetection(db, jm, diskId);
    const groups = getGroups(db, jobId);

    const fileHash = db
      .prepare("SELECT full_hash FROM files WHERE scan_id = ? LIMIT 1")
      .get(scanJob.id) as { full_hash: string };

    expect(groups).toHaveLength(1);
    expect(groups[0].hash_kind).toBe("full");
    expect(groups[0].content_hash).toBe(fileHash.full_hash);
  });

  it("reports zero groups when no duplicates exist", async () => {
    const root = path.join(TMP_BASE, "no-dupes");
    writeTree(root, {
      "a.txt": "content a",
      "b.txt": "content b",
      "c.txt": "content c",
    });
    await scanDisk(db, jm, diskId, root);

    const jobId = await runDuplicateDetection(db, jm, diskId);
    const groups = getGroups(db, jobId);
    expect(groups.length).toBe(0);
  });

  it("completes and transitions job to completed", async () => {
    const root = path.join(TMP_BASE, "status-dupes");
    writeTree(root, { "a.txt": "a", "b.txt": "a" });
    await scanDisk(db, jm, diskId, root);

    const jobId = await runDuplicateDetection(db, jm, diskId);
    expect(jm.getJob(jobId)!.status).toBe("completed");
  });

  it("records items_processed equal to group count", async () => {
    const root = path.join(TMP_BASE, "progress-dupes");
    writeTree(root, {
      "a1.txt": "dup-a", "a2.txt": "dup-a",
      "b1.txt": "dup-b", "b2.txt": "dup-b",
      "unique.txt": "solo",
    });
    await scanDisk(db, jm, diskId, root);

    const jobId = await runDuplicateDetection(db, jm, diskId);
    expect(jm.getJob(jobId)!.items_processed).toBe(2); // 2 groups
  });

  it("filters macOS metadata noise out of duplicate groups", async () => {
    const root = path.join(TMP_BASE, "macos-noise");
    writeTree(root, {
      "photos/vacation-1.jpg": "real duplicate",
      "backup/vacation-1.jpg": "real duplicate",
      ".DS_Store": "metadata duplicate",
      "photos/.DS_Store": "metadata duplicate",
      ".waypoint-disk-id": "disk identity duplicate",
      "backup/.waypoint-disk-id": "disk identity duplicate",
      "._crossfire.lua": "resource fork duplicate",
      "scripts/._crossfire.lua": "resource fork duplicate",
    });
    await scanDisk(db, jm, diskId, root);

    const jobId = await runDuplicateDetection(db, jm, diskId);
    const groups = getGroups(db, jobId);

    expect(groups.length).toBe(1);
    expect(groups[0].file_count).toBe(2);

    const files = getGroupFiles(db, groups[0].id);
    expect(files.map((f) => path.basename(f.path)).sort()).toEqual([
      "vacation-1.jpg",
      "vacation-1.jpg",
    ]);
  });

  it("deleted_at column tracks cleanup and prevents double-deletion", async () => {
    const root = path.join(TMP_BASE, "cleanup-tracking");
    writeTree(root, {
      "photos/img.jpg": "duplicate content",
      "backup/img.jpg": "duplicate content",
    });
    await scanDisk(db, jm, diskId, root);
    const jobId = await runDuplicateDetection(db, jm, diskId);

    const groups = getGroups(db, jobId);
    expect(groups.length).toBe(1);

    const files = getGroupFiles(db, groups[0].id);
    expect(files.length).toBe(2);

    // All files start with deleted_at = null
    const filesWithDeletedAt = db
      .prepare("SELECT file_id, path, deleted_at FROM duplicate_group_files WHERE group_id = ? ORDER BY path")
      .all(groups[0].id) as Array<{ file_id: number; path: string; deleted_at: string | null }>;
    expect(filesWithDeletedAt.every((f) => f.deleted_at === null)).toBe(true);

    // Delete one file and mark it
    const keepPath = files[0].path;
    const deletePath = files[1].path;
    const deleteProof = await makeDeleteProof(deletePath, keepPath);
    await deleteDuplicateFile({
      deletePath,
      keepPath,
      diskMountPath: root,
      ...deleteProof,
    });

    const now = new Date().toISOString();
    db.prepare("UPDATE duplicate_group_files SET deleted_at = ? WHERE group_id = ? AND file_id = ?")
      .run(now, groups[0].id, files[1].file_id);

    // Verify: one file marked as deleted, one still null
    const afterCleanup = db
      .prepare("SELECT file_id, deleted_at FROM duplicate_group_files WHERE group_id = ? ORDER BY path")
      .all(groups[0].id) as Array<{ file_id: number; deleted_at: string | null }>;
    expect(afterCleanup[0].deleted_at).toBeNull();
    expect(afterCleanup[1].deleted_at).not.toBeNull();

    // The deleted file no longer exists on disk
    expect(existsSync(deletePath)).toBe(false);
    expect(existsSync(keepPath)).toBe(true);

    // Attempting to delete the same file again fails (file doesn't exist)
    await expect(
      deleteDuplicateFile({
        deletePath,
        keepPath,
        diskMountPath: root,
        ...deleteProof,
      })
    ).rejects.toThrow("file to delete does not exist");
  });
});
