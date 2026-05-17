import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { JobManager } from "../../../jobs/job-manager";
import { ScanJobRunner } from "../../../jobs/scan/scan-job";
import { DuplicateDetectionJobRunner } from "../../../jobs/duplicates/duplicate-job";
import {
  DirectoryDuplicateCleanupJobRunner,
  type DirectoryDuplicateCleanupPayload,
} from "../../../jobs/duplicates/directory-cleanup-job";
import { initLockManager } from "../../../locks";
import { makeTestDb, insertDisk } from "../../helpers";

const TMP_BASE = "/tmp/waypoint-directory-cleanup-test";

beforeAll(() => mkdirSync(TMP_BASE, { recursive: true }));
afterAll(() => rmSync(TMP_BASE, { recursive: true, force: true }));

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function scanFullHash(
  db: Database,
  jm: JobManager,
  diskId: number,
  mountPath: string
): Promise<number> {
  const scanJob = jm.createJob({ type: "scan", targetDiskId: diskId, payload: { fullHash: true } });
  db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(mountPath, diskId);
  await new ScanJobRunner({
    jobId: scanJob.id,
    jobManager: jm,
    db,
    diskId,
    mountPath,
    fullHash: true,
  }).start();
  return scanJob.id;
}

async function runDuplicateDetection(db: Database, jm: JobManager, diskId: number, scanId: number): Promise<number> {
  const job = jm.createJob({ type: "duplicate_detection", targetDiskId: diskId, payload: { scanId } });
  await new DuplicateDetectionJobRunner({ jobId: job.id, jobManager: jm, db, diskId, scanId }).start();
  return job.id;
}

describe("DirectoryDuplicateCleanupJobRunner", () => {
  let db: Database;
  let jm: JobManager;
  let diskId: number;
  let root: string;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    initLockManager(db);
    root = path.join(TMP_BASE, `disk-${Math.random().toString(36).slice(2)}`);
    diskId = insertDisk(db, { mount_path: root });
  });

  it("deletes every file in delete folders and rmdirs them; keep folder intact", async () => {
    writeTree(root, {
      "album-a/img1.jpg": "img1",
      "album-a/img2.jpg": "img2",
      "album-b/img1.jpg": "img1",
      "album-b/img2.jpg": "img2",
    });
    const scanId = await scanFullHash(db, jm, diskId, root);
    const detectionJobId = await runDuplicateDetection(db, jm, diskId, scanId);

    const group = db
      .prepare(
        `SELECT id, is_eligible_for_cleanup FROM duplicate_directory_groups WHERE duplicate_job_id = ?`
      )
      .get(detectionJobId) as { id: number; is_eligible_for_cleanup: number };
    expect(group.is_eligible_for_cleanup).toBe(1);

    const members = db
      .prepare(
        `SELECT directory_id, path FROM duplicate_directory_group_members WHERE group_id = ? ORDER BY path`
      )
      .all(group.id) as Array<{ directory_id: number; path: string }>;
    expect(members).toHaveLength(2);

    const keepMember   = members[0];
    const deleteMember = members[1];

    // Build the delete-files echo from the scan.
    const deleteFiles = db
      .prepare(
        `SELECT f.id AS file_id, f.path AS abs_path
         FROM files f
         WHERE f.scan_id = ? AND f.directory_id = ?`
      )
      .all(scanId, deleteMember.directory_id) as Array<{ file_id: number; abs_path: string }>;

    const payload: DirectoryDuplicateCleanupPayload = {
      duplicateDirectoryGroupId: group.id,
      keepDirectory: { directoryId: keepMember.directory_id, path: keepMember.path },
      deleteDirectories: [
        {
          directoryId: deleteMember.directory_id,
          path: deleteMember.path,
          files: deleteFiles.map((f) => ({
            fileId: f.file_id,
            relativePath: f.abs_path.slice(deleteMember.path.length + 1),
          })),
        },
      ],
    };

    const cleanupJob = jm.createJob({
      type: "directory_duplicate_cleanup",
      targetDiskId: diskId,
      payload,
    });
    await new DirectoryDuplicateCleanupJobRunner({
      jobId: cleanupJob.id,
      jobManager: jm,
      db,
      diskId,
      diskMountPath: root,
      scanId,
      payload,
    }).start();

    expect(jm.getJob(cleanupJob.id)!.status).toBe("completed");

    // Delete folder is gone, keep folder intact
    expect(existsSync(deleteMember.path)).toBe(false);
    expect(existsSync(keepMember.path)).toBe(true);
    expect(existsSync(path.join(keepMember.path, "img1.jpg"))).toBe(true);
    expect(existsSync(path.join(keepMember.path, "img2.jpg"))).toBe(true);
  });

  it("fails fast when on-disk content has extra files not in the scan", async () => {
    writeTree(root, {
      "x/a.bin": "data",
      "y/a.bin": "data",
    });
    const scanId = await scanFullHash(db, jm, diskId, root);
    const detectionJobId = await runDuplicateDetection(db, jm, diskId, scanId);

    const group = db
      .prepare(
        `SELECT id FROM duplicate_directory_groups WHERE duplicate_job_id = ?`
      )
      .get(detectionJobId) as { id: number };
    const members = db
      .prepare(
        `SELECT directory_id, path FROM duplicate_directory_group_members WHERE group_id = ? ORDER BY path`
      )
      .all(group.id) as Array<{ directory_id: number; path: string }>;

    // Drop an unexpected file into the delete folder after the scan.
    const deleteMember = members[1];
    writeFileSync(path.join(deleteMember.path, "surprise.txt"), "not scanned");

    const deleteFiles = db
      .prepare(
        `SELECT f.id AS file_id, f.path AS abs_path
         FROM files f
         WHERE f.scan_id = ? AND f.directory_id = ?`
      )
      .all(scanId, deleteMember.directory_id) as Array<{ file_id: number; abs_path: string }>;

    const payload: DirectoryDuplicateCleanupPayload = {
      duplicateDirectoryGroupId: group.id,
      keepDirectory: { directoryId: members[0].directory_id, path: members[0].path },
      deleteDirectories: [
        {
          directoryId: deleteMember.directory_id,
          path: deleteMember.path,
          files: deleteFiles.map((f) => ({
            fileId: f.file_id,
            relativePath: f.abs_path.slice(deleteMember.path.length + 1),
          })),
        },
      ],
    };

    const cleanupJob = jm.createJob({
      type: "directory_duplicate_cleanup",
      targetDiskId: diskId,
      payload,
    });
    await new DirectoryDuplicateCleanupJobRunner({
      jobId: cleanupJob.id,
      jobManager: jm,
      db,
      diskId,
      diskMountPath: root,
      scanId,
      payload,
    }).start();

    expect(jm.getJob(cleanupJob.id)!.status).toBe("failed");

    // Nothing was deleted
    expect(existsSync(path.join(deleteMember.path, "a.bin"))).toBe(true);
    expect(existsSync(path.join(deleteMember.path, "surprise.txt"))).toBe(true);
  });

  it("cleans up a folder whose only on-disk extras are echoed noise files (.DS_Store)", async () => {
    writeTree(root, {
      "album-a/img1.jpg": "img1",
      "album-a/img2.jpg": "img2",
      "album-b/img1.jpg": "img1",
      "album-b/img2.jpg": "img2",
    });
    const scanId = await scanFullHash(db, jm, diskId, root);
    const detectionJobId = await runDuplicateDetection(db, jm, diskId, scanId);

    const group = db
      .prepare(`SELECT id FROM duplicate_directory_groups WHERE duplicate_job_id = ?`)
      .get(detectionJobId) as { id: number };
    const members = db
      .prepare(
        `SELECT directory_id, path FROM duplicate_directory_group_members WHERE group_id = ? ORDER BY path`
      )
      .all(group.id) as Array<{ directory_id: number; path: string }>;

    const keepMember = members[0];
    const deleteMember = members[1];

    // Drop noise into the delete folder *after* the scan.
    writeFileSync(path.join(deleteMember.path, ".DS_Store"), "finder noise");
    writeFileSync(path.join(deleteMember.path, "._img1.jpg"), "resource fork");

    const deleteFiles = db
      .prepare(
        `SELECT f.id AS file_id, f.path AS abs_path
         FROM files f
         WHERE f.scan_id = ? AND f.directory_id = ?`
      )
      .all(scanId, deleteMember.directory_id) as Array<{ file_id: number; abs_path: string }>;

    const payload: DirectoryDuplicateCleanupPayload = {
      duplicateDirectoryGroupId: group.id,
      keepDirectory: { directoryId: keepMember.directory_id, path: keepMember.path },
      deleteDirectories: [
        {
          directoryId: deleteMember.directory_id,
          path: deleteMember.path,
          files: deleteFiles.map((f) => ({
            fileId: f.file_id,
            relativePath: f.abs_path.slice(deleteMember.path.length + 1),
          })),
          excludedFiles: [
            { relativePath: ".DS_Store" },
            { relativePath: "._img1.jpg" },
          ],
        },
      ],
    };

    const cleanupJob = jm.createJob({
      type: "directory_duplicate_cleanup",
      targetDiskId: diskId,
      payload,
    });
    await new DirectoryDuplicateCleanupJobRunner({
      jobId: cleanupJob.id,
      jobManager: jm,
      db,
      diskId,
      diskMountPath: root,
      scanId,
      payload,
    }).start();

    expect(jm.getJob(cleanupJob.id)!.status).toBe("completed");
    expect(existsSync(deleteMember.path)).toBe(false);
    expect(existsSync(keepMember.path)).toBe(true);
  });

  it("aborts when an excluded file is on disk but the UI did not echo it", async () => {
    writeTree(root, {
      "album-a/img.jpg": "img",
      "album-b/img.jpg": "img",
    });
    const scanId = await scanFullHash(db, jm, diskId, root);
    const detectionJobId = await runDuplicateDetection(db, jm, diskId, scanId);

    const group = db
      .prepare(`SELECT id FROM duplicate_directory_groups WHERE duplicate_job_id = ?`)
      .get(detectionJobId) as { id: number };
    const members = db
      .prepare(
        `SELECT directory_id, path FROM duplicate_directory_group_members WHERE group_id = ? ORDER BY path`
      )
      .all(group.id) as Array<{ directory_id: number; path: string }>;

    const deleteMember = members[1];

    // .DS_Store appears on disk, but is NOT echoed in excludedFiles — the UI
    // should have shown it and asked the user. Refuse to proceed.
    writeFileSync(path.join(deleteMember.path, ".DS_Store"), "finder noise");

    const deleteFiles = db
      .prepare(
        `SELECT f.id AS file_id, f.path AS abs_path FROM files f WHERE f.scan_id = ? AND f.directory_id = ?`
      )
      .all(scanId, deleteMember.directory_id) as Array<{ file_id: number; abs_path: string }>;

    const payload: DirectoryDuplicateCleanupPayload = {
      duplicateDirectoryGroupId: group.id,
      keepDirectory: { directoryId: members[0].directory_id, path: members[0].path },
      deleteDirectories: [
        {
          directoryId: deleteMember.directory_id,
          path: deleteMember.path,
          files: deleteFiles.map((f) => ({
            fileId: f.file_id,
            relativePath: f.abs_path.slice(deleteMember.path.length + 1),
          })),
          // excludedFiles omitted on purpose
        },
      ],
    };

    const cleanupJob = jm.createJob({
      type: "directory_duplicate_cleanup",
      targetDiskId: diskId,
      payload,
    });
    await new DirectoryDuplicateCleanupJobRunner({
      jobId: cleanupJob.id,
      jobManager: jm,
      db,
      diskId,
      diskMountPath: root,
      scanId,
      payload,
    }).start();

    expect(jm.getJob(cleanupJob.id)!.status).toBe("failed");
    expect(existsSync(path.join(deleteMember.path, ".DS_Store"))).toBe(true);
  });
});
