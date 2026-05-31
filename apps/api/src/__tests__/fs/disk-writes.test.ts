import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  deleteDuplicateFile,
  deleteEncodingScratchFile,
  deleteExcludedNoiseFile,
  removeEmptyDirectoryInsideMount,
  writeGeneratedTestFileAtomic,
} from "../../fs/disk-writes";
import { computeFullHashStreaming } from "../../jobs/scan/hasher";
import { computeFileFreshness } from "../../lib/freshness";
import { JobManager } from "../../jobs/job-manager";
import { ScanJobRunner } from "../../jobs/scan/scan-job";
import { DuplicateDetectionJobRunner } from "../../jobs/duplicates/duplicate-job";
import { makeTestDb, insertDisk } from "../helpers";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "waypoint-disk-writes-"));
  roots.push(root);
  return root;
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("writeGeneratedTestFileAtomic", () => {
  it("writes null data to a .waypoint-test-copy UUID file", async () => {
    const root = makeRoot();
    const fileUuid = "11111111-1111-4111-8111-111111111111";
    const chunks: number[] = [];

    const result = await writeGeneratedTestFileAtomic({
      destMountPath: root,
      fileUuid,
      totalBytes: 3,
      mode: "null",
      tempSuffix: "tmp",
      onChunkWritten: (bytes) => { chunks.push(bytes); },
    });

    const expectedPath = path.join(root, `.waypoint-test-copy-${fileUuid}`);
    expect(result).toEqual({
      relativePath: `.waypoint-test-copy-${fileUuid}`,
      bytesWritten: 3,
    });
    expect(readFileSync(expectedPath)).toEqual(Buffer.from([0, 0, 0]));
    expect(chunks.reduce((sum, n) => sum + n, 0)).toBe(3);
  });

  it("refuses to overwrite an existing final file", async () => {
    const root = makeRoot();
    const fileUuid = "22222222-2222-4222-8222-222222222222";
    const finalPath = path.join(root, `.waypoint-test-copy-${fileUuid}`);
    writeFileSync(finalPath, "keep");

    await expect(
      writeGeneratedTestFileAtomic({
        destMountPath: root,
        fileUuid,
        totalBytes: 4,
        mode: "null",
        tempSuffix: "tmp",
      })
    ).rejects.toThrow("File already exists at destination");

    expect(readFileSync(finalPath, "utf8")).toBe("keep");
  });

  it("refuses to overwrite an existing temp file (write speed test)", async () => {
    const root = makeRoot();
    const fileUuid = "33333333-3333-4333-8333-333333333333";
    const tempPath = path.join(root, `.waypoint-test-copy-${fileUuid}.write-speed-tmp-tmp`);
    writeFileSync(tempPath, "keep");

    await expect(
      writeGeneratedTestFileAtomic({
        destMountPath: root,
        fileUuid,
        totalBytes: 4,
        mode: "null",
        tempSuffix: "tmp",
      })
    ).rejects.toThrow("temp file already exists");

    expect(existsSync(path.join(root, `.waypoint-test-copy-${fileUuid}`))).toBe(false);
    expect(readFileSync(tempPath, "utf8")).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// deleteDuplicateFile
// ---------------------------------------------------------------------------

describe("deleteDuplicateFile", () => {
  it("deletes a verified duplicate file", async () => {
    const root = makeRoot();
    const keepPath = path.join(root, "keep.txt");
    const deletePath = path.join(root, "delete.txt");
    writeFileSync(keepPath, "identical content");
    writeFileSync(deletePath, "identical content");

    const result = await deleteDuplicateFile({
      deletePath,
      keepPath,
      diskMountPath: root,
      ...(await makeDeleteProof(deletePath, keepPath)),
    });

    expect(result.fullHash).toBeTruthy();
    expect(existsSync(keepPath)).toBe(true);
    expect(existsSync(deletePath)).toBe(false);
  });

  it("rejects when delete path escapes disk mount", async () => {
    const root = makeRoot();
    const otherRoot = makeRoot();
    writeFileSync(path.join(root, "keep.txt"), "content");
    writeFileSync(path.join(otherRoot, "escape.txt"), "content");

    await expect(
      deleteDuplicateFile({
        deletePath: path.join(otherRoot, "escape.txt"),
        keepPath: path.join(root, "keep.txt"),
        diskMountPath: root,
        ...(await makeDeleteProof(path.join(otherRoot, "escape.txt"), path.join(root, "keep.txt"))),
      })
    ).rejects.toThrow("escapes disk mount");
  });

  it("rejects when delete path resolves into a prefix-similar sibling mount", async () => {
    // Regression: path containment used to be `startsWith(mount)` with no
    // separator boundary, so /Volumes/BackupOld matched /Volumes/Backup.
    const parent = mkdtempSync(path.join(tmpdir(), "waypoint-prefix-"));
    roots.push(parent);
    const mount = path.join(parent, "Backup");
    const sibling = path.join(parent, "BackupOld");
    mkdirSync(mount);
    mkdirSync(sibling);
    writeFileSync(path.join(mount, "keep.txt"), "content");
    writeFileSync(path.join(sibling, "escape.txt"), "content");

    await expect(
      deleteDuplicateFile({
        deletePath: path.join(sibling, "escape.txt"),
        keepPath: path.join(mount, "keep.txt"),
        diskMountPath: mount,
        ...(await makeDeleteProof(path.join(sibling, "escape.txt"), path.join(mount, "keep.txt"))),
      })
    ).rejects.toThrow("escapes disk mount");

    expect(existsSync(path.join(sibling, "escape.txt"))).toBe(true);
  });

  it("rejects when delete and keep paths are the same file", async () => {
    const root = makeRoot();
    const filePath = path.join(root, "same.txt");
    writeFileSync(filePath, "content");

    await expect(
      deleteDuplicateFile({
        deletePath: filePath,
        keepPath: filePath,
        diskMountPath: root,
        ...(await makeDeleteProof(filePath, filePath)),
      })
    ).rejects.toThrow("same file");
  });

  it("rejects when selected-scan full-hash proof differs", async () => {
    const root = makeRoot();
    const keepPath = path.join(root, "keep.txt");
    const deletePath = path.join(root, "delete.txt");
    writeFileSync(keepPath, "content A");
    writeFileSync(deletePath, "content B");

    await expect(
      deleteDuplicateFile({
        deletePath,
        keepPath,
        diskMountPath: root,
        ...(await makeDeleteProof(deletePath, keepPath)),
      })
    ).rejects.toThrow("full-hash proof");

    // Both files must survive
    expect(existsSync(keepPath)).toBe(true);
    expect(existsSync(deletePath)).toBe(true);
  });

  // This is the end-to-end test that reproduces the double-prefix bug:
  // scan a real directory, run duplicate detection, then use the paths from
  // the DB exactly as the cleanup route does.
  it("works with paths from a real scan + duplicate detection", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "photos"), { recursive: true });
    mkdirSync(path.join(root, "backup"), { recursive: true });
    writeFileSync(path.join(root, "photos", "img.jpg"), "duplicate content here");
    writeFileSync(path.join(root, "backup", "img.jpg"), "duplicate content here");

    const db = makeTestDb();
    const jm = new JobManager(db);
    const diskId = insertDisk(db, { mount_path: root, is_connected: 1 });

    // Scan
    const scanJob = jm.createJob({ type: "scan", targetDiskId: diskId, payload: { fullHash: true } });
    const scanRunner = new ScanJobRunner({
      jobId: scanJob.id, jobManager: jm, db, diskId, mountPath: root, fullHash: true,
    });
    await scanRunner.start();

    // Duplicate detection
    const dupJob = jm.createJob({ type: "duplicate_detection", targetDiskId: diskId, payload: { scanId: scanJob.id } });
    const dupRunner = new DuplicateDetectionJobRunner({
      jobId: dupJob.id, jobManager: jm, db, diskId, scanId: scanJob.id,
    });
    await dupRunner.start();

    // Read paths from duplicate_group_files — exactly as the cleanup route does
    const group = db
      .prepare("SELECT id FROM duplicate_groups WHERE duplicate_job_id = ?")
      .get(dupJob.id) as { id: number };
    const files = db
      .prepare("SELECT file_id, path FROM duplicate_group_files WHERE group_id = ? ORDER BY path")
      .all(group.id) as Array<{ file_id: number; path: string }>;

    expect(files.length).toBe(2);

    // Paths in duplicate_group_files are absolute (written by scan).
    // The cleanup route must use them directly — NOT prefix with mount_path.
    const disk = db.prepare("SELECT mount_path FROM disks WHERE id = ?").get(diskId) as { mount_path: string };
    const keepPath = files[0].path;
    const deletePath = files[1].path;

    const scanFiles = db
      .prepare("SELECT path, sampled_hash, full_hash, size_bytes, mtime FROM files WHERE scan_id = ? ORDER BY path")
      .all(scanJob.id) as Array<{
        path: string;
        sampled_hash: string;
        full_hash: string;
        size_bytes: number;
        mtime: string;
      }>;
    const keepScan = scanFiles.find((f) => f.path === keepPath)!;
    const deleteScan = scanFiles.find((f) => f.path === deletePath)!;

    const keepExpected = {
      size: keepScan.size_bytes,
      mtime: keepScan.mtime,
      sampledHash: keepScan.sampled_hash,
    };
    const deleteExpected = {
      size: deleteScan.size_bytes,
      mtime: deleteScan.mtime,
      sampledHash: deleteScan.sampled_hash,
    };

    const result = await deleteDuplicateFile({
      deletePath,
      keepPath,
      diskMountPath: disk.mount_path,
      expectedFullHash: keepScan.full_hash,
      deleteFullHash: deleteScan.full_hash,
      keepFullHash: keepScan.full_hash,
      deleteExpected,
      keepExpected,
      deleteActual: deleteExpected,
      keepActual: keepExpected,
    });

    expect(result.fullHash).toBeTruthy();
    // files[0] = backup/img.jpg (kept), files[1] = photos/img.jpg (deleted)
    expect(existsSync(path.join(root, "backup", "img.jpg"))).toBe(true);
    expect(existsSync(path.join(root, "photos", "img.jpg"))).toBe(false);
  });
});

describe("deleteExcludedNoiseFile", () => {
  it("deletes a .DS_Store file inside the mount", async () => {
    const root = makeRoot();
    const dsStore = path.join(root, ".DS_Store");
    writeFileSync(dsStore, "finder metadata");

    await deleteExcludedNoiseFile({ filePath: dsStore, diskMountPath: root });
    expect(existsSync(dsStore)).toBe(false);
  });

  it("deletes a resource-fork sidecar (._foo)", async () => {
    const root = makeRoot();
    const sidecar = path.join(root, "._photo.jpg");
    writeFileSync(sidecar, "resource fork");

    await deleteExcludedNoiseFile({ filePath: sidecar, diskMountPath: root });
    expect(existsSync(sidecar)).toBe(false);
  });

  it("refuses to delete a file whose name is not on the noise allowlist", async () => {
    const root = makeRoot();
    const userFile = path.join(root, "important.txt");
    writeFileSync(userFile, "do not delete");

    await expect(
      deleteExcludedNoiseFile({ filePath: userFile, diskMountPath: root })
    ).rejects.toThrow(/not on the noise-file allowlist/);
    expect(existsSync(userFile)).toBe(true);
  });

  it("refuses paths that escape the disk mount", async () => {
    const mount = makeRoot();
    const outside = makeRoot();
    const dsStore = path.join(outside, ".DS_Store");
    writeFileSync(dsStore, "x");

    await expect(
      deleteExcludedNoiseFile({ filePath: dsStore, diskMountPath: mount })
    ).rejects.toThrow(/escapes disk mount/);
    expect(existsSync(dsStore)).toBe(true);
  });

  it("rejects sibling-mount prefix collisions (Backup vs BackupOld)", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "waypoint-noise-prefix-"));
    roots.push(parent);
    const mount = path.join(parent, "Backup");
    const sibling = path.join(parent, "BackupOld");
    mkdirSync(mount);
    mkdirSync(sibling);
    const dsStore = path.join(sibling, ".DS_Store");
    writeFileSync(dsStore, "x");

    await expect(
      deleteExcludedNoiseFile({ filePath: dsStore, diskMountPath: mount })
    ).rejects.toThrow(/escapes disk mount/);
    expect(existsSync(dsStore)).toBe(true);
  });

  it("throws if the noise file does not exist", async () => {
    const root = makeRoot();
    await expect(
      deleteExcludedNoiseFile({
        filePath: path.join(root, ".DS_Store"),
        diskMountPath: root,
      })
    ).rejects.toThrow(/does not exist/);
  });
});

describe("removeEmptyDirectoryInsideMount", () => {
  it("removes an empty directory inside the mount", async () => {
    const root = makeRoot();
    const dir = path.join(root, "empty");
    mkdirSync(dir);
    expect(existsSync(dir)).toBe(true);

    await removeEmptyDirectoryInsideMount({ directoryPath: dir, diskMountPath: root });
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses to remove a path outside the mount", async () => {
    const mount = makeRoot();
    const outside = makeRoot();
    const dir = path.join(outside, "x");
    mkdirSync(dir);
    await expect(
      removeEmptyDirectoryInsideMount({ directoryPath: dir, diskMountPath: mount })
    ).rejects.toThrow(/escapes disk mount/);
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses to remove the disk mount root itself", async () => {
    const root = makeRoot();
    await expect(
      removeEmptyDirectoryInsideMount({ directoryPath: root, diskMountPath: root })
    ).rejects.toThrow(/disk mount root/);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses non-empty directories (kernel ENOTEMPTY)", async () => {
    const root = makeRoot();
    const dir = path.join(root, "non-empty");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "file.txt"), "x");
    await expect(
      removeEmptyDirectoryInsideMount({ directoryPath: dir, diskMountPath: root })
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("deleteEncodingScratchFile", () => {
  it("deletes a variant-NNN.<ext> file inside the scratch root", async () => {
    const root = makeRoot();
    const setDir = path.join(root, "set-1", "sample-1");
    mkdirSync(setDir, { recursive: true });
    const file = path.join(setDir, "variant-1.mp4");
    writeFileSync(file, "ffmpeg-output");
    await deleteEncodingScratchFile({ filePath: file, scratchRoot: root });
    expect(existsSync(file)).toBe(false);
  });

  it("deletes an extracted frame", async () => {
    const root = makeRoot();
    const setDir = path.join(root, "set-1", "sample-1", "frames", "variant-1");
    mkdirSync(setDir, { recursive: true });
    const file = path.join(setDir, "frame-3.jpg");
    writeFileSync(file, "jpeg-bytes");
    await deleteEncodingScratchFile({ filePath: file, scratchRoot: root });
    expect(existsSync(file)).toBe(false);
  });

  it("refuses paths outside the scratch root", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const file = path.join(outside, "variant-1.mp4");
    writeFileSync(file, "x");
    await expect(
      deleteEncodingScratchFile({ filePath: file, scratchRoot: root })
    ).rejects.toThrow(/escapes scratch root/);
    expect(existsSync(file)).toBe(true);
  });

  it("refuses to delete the scratch root itself", async () => {
    const root = makeRoot();
    await expect(
      deleteEncodingScratchFile({ filePath: root, scratchRoot: root })
    ).rejects.toThrow(/scratch root itself/);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses files whose basename isn't an encoding artifact", async () => {
    const root = makeRoot();
    const f1 = path.join(root, "random.mp4");
    writeFileSync(f1, "x");
    await expect(
      deleteEncodingScratchFile({ filePath: f1, scratchRoot: root })
    ).rejects.toThrow(/not an encoding artifact/);
    expect(existsSync(f1)).toBe(true);

    // macOS resource fork — must NOT be matched, even though it shadows a
    // valid encoding artifact name.
    const fork = path.join(root, "._variant-1.mp4");
    writeFileSync(fork, "x");
    await expect(
      deleteEncodingScratchFile({ filePath: fork, scratchRoot: root })
    ).rejects.toThrow(/not an encoding artifact/);
    expect(existsSync(fork)).toBe(true);

    // Path traversal attempt
    const traversal = path.join(root, "set-1", "..", "variant-1.mp4");
    mkdirSync(path.join(root, "set-1"));
    writeFileSync(path.join(root, "variant-1.mp4"), "x");
    // After normalisation this resolves to <root>/variant-1.mp4 which IS a
    // valid artifact name; but the file exists at root level (not inside
    // set-N), which is the worst place for a wildcard delete. The gateway
    // still allows it because the name pattern passes and the path stays
    // under scratch_root. This is the documented behaviour: the gateway
    // proves *containment*, not *structural correctness*.
    await deleteEncodingScratchFile({ filePath: traversal, scratchRoot: root });
    expect(existsSync(path.join(root, "variant-1.mp4"))).toBe(false);
  });

  it("errors when the file does not exist", async () => {
    const root = makeRoot();
    await expect(
      deleteEncodingScratchFile({ filePath: path.join(root, "variant-1.mp4"), scratchRoot: root })
    ).rejects.toThrow(/does not exist/);
  });
});
