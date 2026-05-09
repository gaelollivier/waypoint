import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { JobManager } from "../../../jobs/job-manager";
import { ScanJobRunner } from "../../../jobs/scan/scan-job";
import { DiffJobRunner } from "../../../jobs/diff/diff-job";
import { makeTestDb, insertDisk } from "../../helpers";

const TMP_BASE = "/tmp/waypoint-diff-test";

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

async function runDiff(
  db: Database,
  jm: JobManager,
  sourceDiskId: number,
  destDiskId: number
): Promise<number> {
  const job = jm.createJob({ type: "diff", sourceDiskId, destDiskId });
  const runner = new DiffJobRunner({ jobId: job.id, jobManager: jm, db, sourceDiskId, destDiskId });
  await runner.start();
  return job.id;
}

type DiffDirRow = {
  id: number;
  diff_job_id: number;
  parent_id: number | null;
  path: string;
  added_count: number; added_bytes: number;
  changed_count: number; changed_bytes: number;
  removed_count: number; removed_bytes: number;
  present_count: number; present_bytes: number;
};

type DiffEntryRow = {
  id: number;
  diff_job_id: number;
  diff_dir_id: number | null;
  source_file_id: number | null;
  dest_file_id: number | null;
  kind: string;
  path: string;
  size_bytes: number;
};

function getDirs(db: Database, diffJobId: number): DiffDirRow[] {
  return db
    .prepare("SELECT * FROM diff_dirs WHERE diff_job_id = ? ORDER BY path")
    .all(diffJobId) as DiffDirRow[];
}

function getEntries(db: Database, diffJobId: number): DiffEntryRow[] {
  return db
    .prepare("SELECT * FROM diff_entries WHERE diff_job_id = ? ORDER BY path")
    .all(diffJobId) as DiffEntryRow[];
}

function getEntry(db: Database, diffJobId: number, relativePath: string): DiffEntryRow | null {
  return db
    .prepare("SELECT * FROM diff_entries WHERE diff_job_id = ? AND path = ?")
    .get(diffJobId, relativePath) as DiffEntryRow | null;
}

function getDirByPath(db: Database, diffJobId: number, relativePath: string): DiffDirRow | null {
  return db
    .prepare("SELECT * FROM diff_dirs WHERE diff_job_id = ? AND path = ?")
    .get(diffJobId, relativePath) as DiffDirRow | null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiffJobRunner", () => {
  let db: Database;
  let jm: JobManager;
  let sourceDiskId: number;
  let destDiskId: number;

  beforeEach(() => {
    db = makeTestDb();
    jm = new JobManager(db);
    sourceDiskId = insertDisk(db);
    destDiskId = insertDisk(db);
  });

  // ── Status transitions ─────────────────────────────────────────────────────

  it("completes successfully and transitions job to completed", async () => {
    const src = path.join(TMP_BASE, "status-src");
    const dst = path.join(TMP_BASE, "status-dst");
    writeTree(src, { "a.txt": "hello" });
    writeTree(dst, { "a.txt": "hello" });
    await scanDisk(db, jm, sourceDiskId, src);
    await scanDisk(db, jm, destDiskId, dst);

    const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
    expect(jm.getJob(diffJobId)!.status).toBe("completed");
  });

  it("records items_processed equal to total entry count", async () => {
    const src = path.join(TMP_BASE, "progress-src");
    const dst = path.join(TMP_BASE, "progress-dst");
    writeTree(src, { "a.txt": "a", "b.txt": "b", "sub/c.txt": "c" });
    writeTree(dst, { "a.txt": "a" });
    await scanDisk(db, jm, sourceDiskId, src);
    await scanDisk(db, jm, destDiskId, dst);

    const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
    // 3 source files (b+c added, a present) + 0 removed = 3 entries
    expect(jm.getJob(diffJobId)!.items_processed).toBe(3);
  });

  // ── Entry classification ───────────────────────────────────────────────────

  describe("entry classification", () => {
    it("marks a file only on source as 'added'", async () => {
      const src = path.join(TMP_BASE, "added-src");
      const dst = path.join(TMP_BASE, "added-dst");
      writeTree(src, { "new.txt": "brand new" });
      writeTree(dst, { ".keep": "" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      // path is relative to mount
      const entry = getEntry(db, diffJobId, "/new.txt");
      expect(entry).not.toBeNull();
      expect(entry!.kind).toBe("added");
      expect(entry!.source_file_id).not.toBeNull();
      expect(entry!.dest_file_id).toBeNull();
    });

    it("marks a file only on dest as 'removed'", async () => {
      const src = path.join(TMP_BASE, "removed-src");
      const dst = path.join(TMP_BASE, "removed-dst");
      writeTree(src, { ".keep": "" });
      writeTree(dst, { "old.txt": "old data", ".keep": "" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const entry = getEntry(db, diffJobId, "/old.txt");
      expect(entry).not.toBeNull();
      expect(entry!.kind).toBe("removed");
      expect(entry!.source_file_id).toBeNull();
      expect(entry!.dest_file_id).not.toBeNull();
    });

    it("marks a file with matching path+hash as 'present'", async () => {
      const src = path.join(TMP_BASE, "present-src");
      const dst = path.join(TMP_BASE, "present-dst");
      const content = "identical content";
      writeTree(src, { "same.txt": content });
      writeTree(dst, { "same.txt": content });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const entry = getEntry(db, diffJobId, "/same.txt");
      expect(entry).not.toBeNull();
      expect(entry!.kind).toBe("present");
      expect(entry!.source_file_id).not.toBeNull();
      expect(entry!.dest_file_id).not.toBeNull();
    });

    it("marks a file with matching path but different content as 'changed'", async () => {
      const src = path.join(TMP_BASE, "changed-src");
      const dst = path.join(TMP_BASE, "changed-dst");
      // Content must differ enough that sampled hash differs (> 100KB threshold is
      // for full hash; small files use full content hash — any difference suffices)
      writeTree(src, { "file.txt": "source content" });
      writeTree(dst, { "file.txt": "dest content — different" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const entry = getEntry(db, diffJobId, "/file.txt");
      expect(entry).not.toBeNull();
      expect(entry!.kind).toBe("changed");
      expect(entry!.source_file_id).not.toBeNull();
      expect(entry!.dest_file_id).not.toBeNull();
    });

    it("handles a mixed tree correctly", async () => {
      const src = path.join(TMP_BASE, "mixed-src");
      const dst = path.join(TMP_BASE, "mixed-dst");
      writeTree(src, {
        "added.txt":   "only on source",
        "same.txt":    "identical",
        "changed.txt": "source version",
      });
      writeTree(dst, {
        "same.txt":    "identical",
        "changed.txt": "dest version different",
        "removed.txt": "only on dest",
      });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const entries = getEntries(db, diffJobId);
      const byName: Record<string, string> = {};
      for (const e of entries) byName[path.basename(e.path)] = e.kind;

      expect(byName["added.txt"]).toBe("added");
      expect(byName["same.txt"]).toBe("present");
      expect(byName["changed.txt"]).toBe("changed");
      expect(byName["removed.txt"]).toBe("removed");
    });

    it("stores correct size_bytes on each entry", async () => {
      const src = path.join(TMP_BASE, "sizes-src");
      const dst = path.join(TMP_BASE, "sizes-dst");
      const payload = "x".repeat(1000);
      writeTree(src, { "big.txt": payload });
      writeTree(dst, { ".keep": "" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const entry = getEntry(db, diffJobId, "/big.txt");
      expect(entry!.size_bytes).toBe(1000);
    });
  });

  // ── Identical disks ────────────────────────────────────────────────────────

  it("produces only 'present' entries when disks are identical", async () => {
    const src = path.join(TMP_BASE, "identical-src");
    const dst = path.join(TMP_BASE, "identical-dst");
    const files = { "a.txt": "same", "sub/b.txt": "same too" };
    writeTree(src, files);
    writeTree(dst, files);
    await scanDisk(db, jm, sourceDiskId, src);
    await scanDisk(db, jm, destDiskId, dst);

    const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
    const entries = getEntries(db, diffJobId);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.kind === "present")).toBe(true);
  });

  // ── diff_dirs rollup ───────────────────────────────────────────────────────

  describe("diff_dirs rollup", () => {
    it("creates a root '/' diff_dir row with null parent_id", async () => {
      const src = path.join(TMP_BASE, "root-src");
      const dst = path.join(TMP_BASE, "root-dst");
      writeTree(src, { "a.txt": "a" });
      writeTree(dst, { ".keep": "" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const root = getDirByPath(db, diffJobId, "/");
      expect(root).not.toBeNull();
      expect(root!.parent_id).toBeNull();
    });

    it("root dir aggregate reflects all entries", async () => {
      const src = path.join(TMP_BASE, "agg-src");
      const dst = path.join(TMP_BASE, "agg-dst");
      writeTree(src, {
        "added.txt":   "only on source",
        "same.txt":    "identical",
        "changed.txt": "source version",
      });
      writeTree(dst, {
        "same.txt":    "identical",
        "changed.txt": "dest version different",
        "removed.txt": "only on dest",
      });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const root = getDirByPath(db, diffJobId, "/");
      expect(root!.added_count).toBe(1);
      expect(root!.changed_count).toBe(1);
      expect(root!.removed_count).toBe(1);
      expect(root!.present_count).toBe(1);
    });

    it("subdirectory aggregate only includes its own descendants", async () => {
      const src = path.join(TMP_BASE, "subdir-agg-src");
      const dst = path.join(TMP_BASE, "subdir-agg-dst");
      writeTree(src, {
        "top.txt":       "top level",
        "sub/file1.txt": "in sub",
        "sub/file2.txt": "in sub — source version",
      });
      writeTree(dst, {
        "top.txt":       "top level",
        "sub/file1.txt": "in sub",
        "sub/file2.txt": "in sub — dest version different",
      });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);

      // Sub directory: file1 present, file2 changed
      const subDir = getDirByPath(db, diffJobId, "/sub");
      expect(subDir).not.toBeNull();
      expect(subDir!.present_count).toBe(1);
      expect(subDir!.changed_count).toBe(1);
      expect(subDir!.added_count).toBe(0);
      expect(subDir!.removed_count).toBe(0);

      // Root: top.txt present + propagated from /sub
      const root = getDirByPath(db, diffJobId, "/");
      expect(root!.present_count).toBe(2); // top.txt + sub/file1.txt
      expect(root!.changed_count).toBe(1); // sub/file2.txt
      expect(root!.added_count).toBe(0);
      expect(root!.removed_count).toBe(0);
    });

    it("rollup propagates added_bytes to ancestor dirs", async () => {
      const src = path.join(TMP_BASE, "bytes-src");
      const dst = path.join(TMP_BASE, "bytes-dst");
      const payload = "y".repeat(500);
      writeTree(src, { "deep/nested/new.txt": payload });
      writeTree(dst, { ".keep": "" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const root = getDirByPath(db, diffJobId, "/");
      expect(root!.added_bytes).toBe(500);
      expect(root!.added_count).toBe(1);

      // Intermediate /deep dir should also carry the bytes
      const deepDir = getDirByPath(db, diffJobId, "/deep");
      expect(deepDir!.added_bytes).toBe(500);
    });

    it("each diff_dir has the correct parent_id chain up to root", async () => {
      const src = path.join(TMP_BASE, "chain-src");
      const dst = path.join(TMP_BASE, "chain-dst");
      writeTree(src, { "a/b/c.txt": "deep" });
      writeTree(dst, { ".keep": "" });
      await scanDisk(db, jm, sourceDiskId, src);
      await scanDisk(db, jm, destDiskId, dst);

      const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
      const dirs = getDirs(db, diffJobId);

      const byId = new Map(dirs.map((d) => [d.id, d]));
      for (const dir of dirs) {
        if (dir.parent_id === null) {
          expect(dir.path).toBe("/");
        } else {
          expect(byId.has(dir.parent_id)).toBe(true);
          // Parent path should be dirname of child path
          expect(path.dirname(dir.path)).toBe(byId.get(dir.parent_id)!.path);
        }
      }
    });
  });

  // ── diff_entries linked to diff_dirs ──────────────────────────────────────

  it("diff_entries have a valid diff_dir_id pointing to their containing directory", async () => {
    const src = path.join(TMP_BASE, "dirlink-src");
    const dst = path.join(TMP_BASE, "dirlink-dst");
    writeTree(src, { "sub/file.txt": "in sub" });
    writeTree(dst, { ".keep": "" });
    await scanDisk(db, jm, sourceDiskId, src);
    await scanDisk(db, jm, destDiskId, dst);

    const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
    const entries = getEntries(db, diffJobId).filter((e) => !e.path.endsWith(".keep"));
    for (const entry of entries) {
      expect(entry.diff_dir_id).not.toBeNull();
      const dir = db
        .prepare("SELECT * FROM diff_dirs WHERE id = ?")
        .get(entry.diff_dir_id!) as DiffDirRow | null;
      expect(dir).not.toBeNull();
      // The dir's path should be the parent of the entry's path
      expect(dir!.path).toBe(path.dirname(entry.path));
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("handles source with a single file and nearly-empty dest", async () => {
    const src = path.join(TMP_BASE, "single-src");
    const dst = path.join(TMP_BASE, "single-dst");
    writeTree(src, { "only.txt": "content" });
    writeTree(dst, { ".keep": "" });
    await scanDisk(db, jm, sourceDiskId, src);
    await scanDisk(db, jm, destDiskId, dst);

    const diffJobId = await runDiff(db, jm, sourceDiskId, destDiskId);
    const added = getEntries(db, diffJobId).filter((e) => e.kind === "added");
    expect(added.length).toBe(1);
    expect(added[0].path).toBe("/only.txt");
  });

  it("two diff jobs for the same pair produce independent diff_entries rows", async () => {
    const src = path.join(TMP_BASE, "multi-src");
    const dst = path.join(TMP_BASE, "multi-dst");
    writeTree(src, { "x.txt": "x" });
    writeTree(dst, { ".keep": "" });
    await scanDisk(db, jm, sourceDiskId, src);
    await scanDisk(db, jm, destDiskId, dst);

    const diffJobId1 = await runDiff(db, jm, sourceDiskId, destDiskId);
    const diffJobId2 = await runDiff(db, jm, sourceDiskId, destDiskId);

    const entries1 = getEntries(db, diffJobId1);
    const entries2 = getEntries(db, diffJobId2);

    expect(entries1.every((e) => e.diff_job_id === diffJobId1)).toBe(true);
    expect(entries2.every((e) => e.diff_job_id === diffJobId2)).toBe(true);
    expect(entries1.length).toBeGreaterThan(0);
    expect(entries2.length).toBeGreaterThan(0);
  });
});
