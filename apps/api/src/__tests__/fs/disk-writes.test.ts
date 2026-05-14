import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { writeGeneratedTestFileAtomic } from "../../fs/disk-writes";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "waypoint-disk-writes-"));
  roots.push(root);
  return root;
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
      onChunkWritten: (bytes) => chunks.push(bytes),
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

  it("refuses to overwrite an existing temp file", async () => {
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
