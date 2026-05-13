import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { JobManager } from "../../../jobs/job-manager";
import { ScanJobRunner } from "../../../jobs/scan/scan-job";
import { DuplicateDetectionJobRunner } from "../../../jobs/duplicates/duplicate-job";
import { makeTestDb, insertDisk } from "../../helpers";

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
  const job = jm.createJob({ type: "duplicate_detection", targetDiskId: diskId });
  const runner = new DuplicateDetectionJobRunner({ jobId: job.id, jobManager: jm, db, diskId });
  await runner.start();
  return job.id;
}

type DuplicateGroupRow = {
  id: number;
  duplicate_job_id: number;
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
      "._crossfire.lua": "resource fork duplicate",
      "scripts/._crossfire.lua": "resource fork duplicate",
      "__MACOSX/photos/._vacation-1.jpg": "archive metadata duplicate",
      "exports/__MACOSX/._vacation-2.jpg": "archive metadata duplicate",
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
});
