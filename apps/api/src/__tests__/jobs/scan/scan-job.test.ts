import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { JobManager } from "../../../jobs/job-manager";
import { ScanJobRunner } from "../../../jobs/scan/scan-job";
import { recomputeAggregates } from "../../../jobs/scan/walker";
import { makeTestDb, insertDisk } from "../../helpers";

const TMP_BASE = "/tmp/waypoint-scan-test";

beforeAll(() => mkdirSync(TMP_BASE, { recursive: true }));
afterAll(() => rmSync(TMP_BASE, { recursive: true, force: true }));

/** Creates a temp directory with a known file tree and returns its path. */
function makeFixtureTree(name: string): string {
  const root = path.join(TMP_BASE, name);
  mkdirSync(path.join(root, "subdir", "nested"), { recursive: true });
  writeFileSync(path.join(root, "a.txt"), "file a contents");
  writeFileSync(path.join(root, "b.txt"), "file b contents — slightly longer");
  writeFileSync(path.join(root, "subdir", "c.txt"), "file c in subdir");
  writeFileSync(path.join(root, "subdir", "nested", "d.txt"), "deep nested file d");
  return root;
}

function makeRunner(
  db: Database,
  jm: JobManager,
  diskId: number,
  mountPath: string
): ScanJobRunner {
  const job = jm.createJob({ type: "scan", targetDiskId: diskId });
  return new ScanJobRunner({ jobId: job.id, jobManager: jm, db, diskId, mountPath });
}

describe("ScanJobRunner", () => {
  let db: Database;
  let jm: JobManager;
  let diskId: number;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    diskId = insertDisk(db);
  });

  describe("full scan", () => {
    it("completes successfully and transitions to completed", async () => {
      const root = makeFixtureTree("full-scan");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();
      expect(jm.getJob(runner.jobId)!.status).toBe("completed");
    });

    it("indexes all files (a.txt, b.txt, subdir/c.txt, nested/d.txt)", async () => {
      const root = makeFixtureTree("index-all");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const files = db
        .prepare("SELECT name FROM files WHERE scan_id = ? ORDER BY name")
        .all(runner.jobId) as Array<{ name: string }>;
      const names = files.map((f) => f.name);

      expect(names).toContain("a.txt");
      expect(names).toContain("b.txt");
      expect(names).toContain("c.txt");
      expect(names).toContain("d.txt");
      expect(names).toHaveLength(4);
    });

    it("records sampled_hash for each file", async () => {
      const root = makeFixtureTree("hash-check");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const unhashed = db
        .prepare("SELECT name FROM files WHERE scan_id = ? AND sampled_hash IS NULL")
        .all(runner.jobId);
      expect(unhashed).toHaveLength(0);
    });

    it("creates directory rows for root, subdir, and nested", async () => {
      const root = makeFixtureTree("dir-rows");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const dirs = db
        .prepare("SELECT name FROM directories WHERE scan_id = ? ORDER BY name")
        .all(runner.jobId) as Array<{ name: string }>;
      const names = dirs.map((d) => d.name);
      expect(names).toContain("subdir");
      expect(names).toContain("nested");
    });

    it("updates disks.last_scan_job_id and last_scan_at on completion", async () => {
      const root = makeFixtureTree("disk-meta");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const disk = db.prepare("SELECT * FROM disks WHERE id = ?").get(diskId) as any;
      expect(disk.last_scan_job_id).toBe(runner.jobId);
      expect(disk.last_scan_at).not.toBeNull();
    });

    it("increments items_processed counter on the job", async () => {
      const root = makeFixtureTree("progress");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const job = jm.getJob(runner.jobId)!;
      expect(job.items_processed).toBe(4); // a, b, c, d
    });
  });

  describe("mtime+size shortcut", () => {
    it("reuses stored hash for unchanged files on re-scan", async () => {
      const root = makeFixtureTree("rescan");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);

      // First scan
      const runner1 = makeRunner(db, jm, diskId, root);
      await runner1.start();

      // Corrupt the hash in the first scan's DB rows to detect if re-hash occurs
      db.prepare("UPDATE files SET sampled_hash = 'FAKE' WHERE scan_id = ? AND name = 'a.txt'").run(runner1.jobId);

      // Second scan — a.txt hasn't changed, so FAKE hash should be preserved
      // (the walker reads from the previous scan's rows for hash reuse)
      const runner2 = makeRunner(db, jm, diskId, root);
      await runner2.start();

      const hashAfter = (
        db
          .prepare("SELECT sampled_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner2.jobId) as any
      ).sampled_hash;

      expect(hashAfter).toBe("FAKE"); // shortcut kicked in, no re-hash
    });

    it("re-hashes a file when its mtime changes", async () => {
      const root = makeFixtureTree("mtime-change");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);

      // First scan
      const runner1 = makeRunner(db, jm, diskId, root);
      await runner1.start();

      const hashBefore = (
        db
          .prepare("SELECT sampled_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner1.jobId) as any
      ).sampled_hash;

      // Modify the file (changes mtime)
      await new Promise((r) => setTimeout(r, 10)); // ensure mtime differs
      writeFileSync(path.join(root, "a.txt"), "completely different content now");

      // Second scan — should re-hash
      const runner2 = makeRunner(db, jm, diskId, root);
      await runner2.start();

      const hashAfter = (
        db
          .prepare("SELECT sampled_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner2.jobId) as any
      ).sampled_hash;

      expect(hashAfter).not.toBe(hashBefore);
    });
  });

  describe("fullHash mode", () => {
    function makeFullHashRunner(
      db: Database,
      jm: JobManager,
      diskId: number,
      mountPath: string
    ): ScanJobRunner {
      const job = jm.createJob({
        type: "scan",
        targetDiskId: diskId,
        payload: { fullHash: true },
      });
      return new ScanJobRunner({
        jobId: job.id,
        jobManager: jm,
        db,
        diskId,
        mountPath,
        fullHash: true,
      });
    }

    it("populates files.full_hash for every file when enabled", async () => {
      const root = makeFixtureTree("full-hash-on");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeFullHashRunner(db, jm, diskId, root);
      await runner.start();

      const rows = db
        .prepare("SELECT name, full_hash FROM files WHERE scan_id = ?")
        .all(runner.jobId) as Array<{ name: string; full_hash: string | null }>;

      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.full_hash).not.toBeNull();
        expect(row.full_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("leaves full_hash null when the flag is not set", async () => {
      const root = makeFixtureTree("full-hash-off");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const withFull = db
        .prepare("SELECT COUNT(*) AS n FROM files WHERE scan_id = ? AND full_hash IS NOT NULL")
        .get(runner.jobId) as { n: number };
      expect(withFull.n).toBe(0);
    });

    it("recomputes full_hash even when the sampled_hash still matches the prior scan", async () => {
      const root = makeFixtureTree("full-hash-reuse");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);

      const runner1 = makeFullHashRunner(db, jm, diskId, root);
      await runner1.start();

      // Mark the stored full_hash with a sentinel so we can detect re-hashing.
      db.prepare("UPDATE files SET full_hash = 'SENTINEL' WHERE scan_id = ? AND name = 'a.txt'").run(runner1.jobId);

      const runner2 = makeFullHashRunner(db, jm, diskId, root);
      await runner2.start();

      const hashAfter = (
        db
          .prepare("SELECT full_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner2.jobId) as any
      ).full_hash;

      expect(hashAfter).not.toBe("SENTINEL");
      expect(hashAfter).toMatch(/^[0-9a-f]{64}$/);
    });

    it("recomputes full_hash after a touch even when content is unchanged", async () => {
      const root = makeFixtureTree("full-hash-touch");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);

      const runner1 = makeFullHashRunner(db, jm, diskId, root);
      await runner1.start();

      // Sentinel the full_hash so a re-read would replace it with a real hex digest.
      db.prepare("UPDATE files SET full_hash = 'SENTINEL' WHERE scan_id = ? AND name = 'a.txt'").run(runner1.jobId);

      // Simulate `touch` — bump mtime, keep content identical.
      const filePath = path.join(root, "a.txt");
      const future = new Date(Date.now() + 60_000);
      const { utimesSync } = await import("fs");
      utimesSync(filePath, future, future);

      const runner2 = makeFullHashRunner(db, jm, diskId, root);
      await runner2.start();

      const hashAfter = (
        db
          .prepare("SELECT full_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner2.jobId) as any
      ).full_hash;

      // Full-hash scans are integrity scans, so the full hash is recomputed
      // even when the sampled hash proves the file content appears unchanged.
      expect(hashAfter).not.toBe("SENTINEL");
      expect(hashAfter).toMatch(/^[0-9a-f]{64}$/);
    });

    it("recomputes full_hash when content changes (sampled_hash differs)", async () => {
      const root = makeFixtureTree("full-hash-content-change");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);

      const runner1 = makeFullHashRunner(db, jm, diskId, root);
      await runner1.start();
      db.prepare("UPDATE files SET full_hash = 'SENTINEL' WHERE scan_id = ? AND name = 'a.txt'").run(runner1.jobId);

      // Modify content so the sampled hash will differ.
      await new Promise((r) => setTimeout(r, 10));
      writeFileSync(path.join(root, "a.txt"), "totally different content here");

      const runner2 = makeFullHashRunner(db, jm, diskId, root);
      await runner2.start();

      const hashAfter = (
        db
          .prepare("SELECT full_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner2.jobId) as any
      ).full_hash;

      expect(hashAfter).not.toBe("SENTINEL");
      expect(hashAfter).toMatch(/^[0-9a-f]{64}$/);
    });

    it("carries full_hash forward even when the next scan is non-fullHash", async () => {
      const root = makeFixtureTree("full-hash-carry");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);

      const runner1 = makeFullHashRunner(db, jm, diskId, root);
      await runner1.start();
      db.prepare("UPDATE files SET full_hash = 'CARRY' WHERE scan_id = ? AND name = 'a.txt'").run(runner1.jobId);

      // Second scan is a plain sampled scan — but it should still preserve
      // the stored full_hash so we don't drop accumulated data.
      const runner2 = makeRunner(db, jm, diskId, root);
      await runner2.start();

      const hashAfter = (
        db
          .prepare("SELECT full_hash FROM files WHERE scan_id = ? AND name = 'a.txt'")
          .get(runner2.jobId) as any
      ).full_hash;

      expect(hashAfter).toBe("CARRY");
    });
  });

  describe("walk queue / resumability", () => {
    it("seeds the walk queue with root on first run", async () => {
      const root = makeFixtureTree("queue-seed");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const job = jm.createJob({ type: "scan", targetDiskId: diskId });
      const runner = new ScanJobRunner({ jobId: job.id, jobManager: jm, db, diskId, mountPath: root });

      // Manually init queue without running
      (runner as any).initOrResumeQueue();

      const rows = db
        .prepare("SELECT path, status FROM scan_walk_queue WHERE scan_job_id = ?")
        .all(job.id) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe(root);
      expect(rows[0].status).toBe("pending");
    });

    it("resets in_progress rows to pending on resume", async () => {
      const root = makeFixtureTree("resume-reset");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const job = jm.createJob({ type: "scan", targetDiskId: diskId });

      // Manually insert a queue entry stuck in_progress (simulates crash)
      db.prepare(
        `INSERT INTO scan_walk_queue (scan_job_id, disk_id, path, status, started_at)
         VALUES (?, ?, ?, 'in_progress', ?)`
      ).run(job.id, diskId, root, new Date().toISOString());

      const runner = new ScanJobRunner({ jobId: job.id, jobManager: jm, db, diskId, mountPath: root });
      (runner as any).initOrResumeQueue();

      const stuck = db
        .prepare("SELECT status FROM scan_walk_queue WHERE scan_job_id = ? AND path = ?")
        .get(job.id, root) as any;
      expect(stuck.status).toBe("pending");
    });
  });

  describe("recomputeAggregates", () => {
    it("sets direct_file_count for each directory", async () => {
      const root = makeFixtureTree("agg-direct");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      // root dir should have 2 direct files (a.txt, b.txt)
      const rootDir = db
        .prepare("SELECT * FROM directories WHERE scan_id = ? AND path = ?")
        .get(runner.jobId, root) as any;
      expect(rootDir.direct_file_count).toBe(2);

      // subdir should have 1 direct file (c.txt)
      const subDir = db
        .prepare("SELECT * FROM directories WHERE scan_id = ? AND name = 'subdir'")
        .get(runner.jobId) as any;
      expect(subDir.direct_file_count).toBe(1);
    });

    it("sets total file_count recursively", async () => {
      const root = makeFixtureTree("agg-total");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const rootDir = db
        .prepare("SELECT * FROM directories WHERE scan_id = ? AND path = ?")
        .get(runner.jobId, root) as any;
      // root contains all 4 files recursively
      expect(rootDir.file_count).toBe(4);
    });

    it("sets total_size_bytes correctly", async () => {
      const root = makeFixtureTree("agg-size");
      db.prepare("UPDATE disks SET mount_path = ?, is_connected = 1 WHERE id = ?").run(root, diskId);
      const runner = makeRunner(db, jm, diskId, root);
      await runner.start();

      const totalInDb = (
        db
          .prepare("SELECT SUM(size_bytes) AS s FROM files WHERE scan_id = ?")
          .get(runner.jobId) as any
      ).s;

      const rootDir = db
        .prepare("SELECT total_size_bytes FROM directories WHERE scan_id = ? AND path = ?")
        .get(runner.jobId, root) as any;
      expect(rootDir.total_size_bytes).toBe(totalInDb);
    });
  });
});
