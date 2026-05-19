import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { JobManager } from "../../../jobs/job-manager";
import { ScanJobRunner } from "../../../jobs/scan/scan-job";
import { DuplicateDetectionJobRunner } from "../../../jobs/duplicates/duplicate-job";
import { deleteDuplicateFile } from "../../../fs/disk-writes";
import { computeFullHashStreaming } from "../../../jobs/scan/hasher";
import { computeFileFreshness } from "../../../lib/freshness";
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
  const [deleteActual, keepActual] = await Promise.all([
    computeFileFreshness(deletePath),
    computeFileFreshness(keepPath),
  ]);
  return {
    expectedFullHash: keepFullHash,
    deleteFullHash,
    keepFullHash,
    deleteExpected: deleteActual,
    keepExpected: keepActual,
    deleteActual,
    keepActual,
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

  it("ignores files under an excluded path (group never forms)", async () => {
    const root = path.join(TMP_BASE, "excluded-pure");
    writeTree(root, {
      "Archive/cd1/support.dll": "shared archive blob",
      "Archive/cd2/support.dll": "shared archive blob",
      "Archive/cd3/support.dll": "shared archive blob",
    });
    await scanDisk(db, jm, diskId, root);

    db.prepare(`INSERT INTO excluded_paths (disk_id, path) VALUES (?, ?)`)
      .run(diskId, path.join(root, "Archive"));

    const jobId = await runDuplicateDetection(db, jm, diskId);
    expect(getGroups(db, jobId).length).toBe(0);
  });

  it("ignores excluded copies but still groups remaining non-excluded copies", async () => {
    const root = path.join(TMP_BASE, "excluded-mixed");
    writeTree(root, {
      "Archive/copy.jpg":  "same",
      "Photos/copy.jpg":   "same",
      "Backups/copy.jpg":  "same",
    });
    await scanDisk(db, jm, diskId, root);

    db.prepare(`INSERT INTO excluded_paths (disk_id, path) VALUES (?, ?)`)
      .run(diskId, path.join(root, "Archive"));

    const jobId = await runDuplicateDetection(db, jm, diskId);
    const groups = getGroups(db, jobId);
    expect(groups.length).toBe(1);
    expect(groups[0].file_count).toBe(2);

    const files = getGroupFiles(db, groups[0].id);
    const paths = files.map((f) => f.path).sort();
    expect(paths.every((p) => !p.startsWith(path.join(root, "Archive")))).toBe(true);
  });

  it("ignores files at the exact excluded path (single-file exclusion)", async () => {
    const root = path.join(TMP_BASE, "excluded-exact");
    writeTree(root, {
      "weird.bin": "weird content",
      "other/weird.bin": "weird content",
    });
    await scanDisk(db, jm, diskId, root);

    // Exclude the file path itself, not a directory above it.
    db.prepare(`INSERT INTO excluded_paths (disk_id, path) VALUES (?, ?)`)
      .run(diskId, path.join(root, "weird.bin"));

    const jobId = await runDuplicateDetection(db, jm, diskId);
    // Only one copy remains visible to detection → no group.
    expect(getGroups(db, jobId).length).toBe(0);
  });

  it("exclusions on another disk don't affect this disk", async () => {
    const root = path.join(TMP_BASE, "excluded-other-disk");
    writeTree(root, {
      "Archive/copy.jpg": "same",
      "Photos/copy.jpg":  "same",
    });
    await scanDisk(db, jm, diskId, root);

    // Register a second disk and exclude on it instead — must not affect diskId.
    const otherDisk = insertDisk(db, { mount_path: "/tmp/waypoint-duplicate-test/disk-other" });
    db.prepare(`INSERT INTO excluded_paths (disk_id, path) VALUES (?, ?)`)
      .run(otherDisk, path.join(root, "Archive"));

    const jobId = await runDuplicateDetection(db, jm, diskId);
    const groups = getGroups(db, jobId);
    expect(groups.length).toBe(1);
    expect(groups[0].file_count).toBe(2);
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

  it("marks directory groups eligible for cleanup only when all descendants have full_hash", async () => {
    // Sampled scan: identical "album/" dirs exist but no full_hash on any file.
    const root = path.join(TMP_BASE, "dir-eligibility-sampled");
    writeTree(root, {
      "album-a/img1.jpg": "img1-content",
      "album-a/img2.jpg": "img2-content",
      "album-b/img1.jpg": "img1-content",
      "album-b/img2.jpg": "img2-content",
    });
    await scanDisk(db, jm, diskId, root);
    let jobId = await runDuplicateDetection(db, jm, diskId);

    const sampledGroup = db
      .prepare(
        "SELECT id, is_eligible_for_cleanup FROM duplicate_directory_groups WHERE duplicate_job_id = ?"
      )
      .get(jobId) as { id: number; is_eligible_for_cleanup: number };
    expect(sampledGroup).toBeDefined();
    expect(sampledGroup.is_eligible_for_cleanup).toBe(0);

    // Re-scan with fullHash so every descendant file now carries a full_hash.
    const fullScan = jm.createJob({ type: "scan", targetDiskId: diskId, payload: { fullHash: true } });
    const fullRunner = new ScanJobRunner({
      jobId: fullScan.id,
      jobManager: jm,
      db,
      diskId,
      mountPath: root,
      fullHash: true,
    });
    await fullRunner.start();
    jobId = await runDuplicateDetection(db, jm, diskId);

    const fullGroup = db
      .prepare(
        "SELECT id, is_eligible_for_cleanup FROM duplicate_directory_groups WHERE duplicate_job_id = ?"
      )
      .get(jobId) as { id: number; is_eligible_for_cleanup: number };
    expect(fullGroup).toBeDefined();
    expect(fullGroup.is_eligible_for_cleanup).toBe(1);
  });

  it("deleted_files tracks cleanup and survives re-detection on the same scan", async () => {
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

    // No rows yet — deleted_files is empty before any cleanup.
    const initial = db
      .prepare("SELECT COUNT(*) AS n FROM deleted_files")
      .get() as { n: number };
    expect(initial.n).toBe(0);

    const keepPath = files[0].path;
    const deletePath = files[1].path;
    const deleteProof = await makeDeleteProof(deletePath, keepPath);
    await deleteDuplicateFile({
      deletePath,
      keepPath,
      diskMountPath: root,
      ...deleteProof,
    });

    // Record the deletion via the new table (mirrors what the cleanup route
    // does after deleteDuplicateFile succeeds).
    const scanId = db
      .prepare("SELECT scan_id FROM files WHERE id = ?")
      .get(files[1].file_id) as { scan_id: number };
    db.prepare(
      "INSERT INTO deleted_files (file_id, scan_id, deleted_at) VALUES (?, ?, ?)"
    ).run(files[1].file_id, scanId.scan_id, new Date().toISOString());

    // The deleted file no longer exists on disk.
    expect(existsSync(deletePath)).toBe(false);
    expect(existsSync(keepPath)).toBe(true);

    // Re-run detection on the same scan; the new group's members should still
    // show the same deleted_files row because file_id is scan-snapshot stable.
    const rerunJobId = await runDuplicateDetection(db, jm, diskId);
    const rerunGroups = getGroups(db, rerunJobId);
    expect(rerunGroups.length).toBe(1);
    const rerunFiles = getGroupFiles(db, rerunGroups[0].id);
    const stillDeleted = db
      .prepare("SELECT file_id FROM deleted_files WHERE file_id IN (?, ?)")
      .all(rerunFiles[0].file_id, rerunFiles[1].file_id) as Array<{ file_id: number }>;
    expect(stillDeleted).toHaveLength(1);
    expect(stillDeleted[0].file_id).toBe(files[1].file_id);

    // Attempting to delete the same file again fails (file doesn't exist).
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
