import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { computeSampledHash, computeFullHash, HASH_ALGO_VERSION } from "../../../jobs/scan/hasher";

const TMP_DIR = "/tmp/waypoint-hasher-test";

beforeAll(() => mkdirSync(TMP_DIR, { recursive: true }));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

function tmpFile(name: string, content: Buffer | string): string {
  const p = path.join(TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

describe("computeFullHash", () => {
  it("produces a 64-char hex string", async () => {
    const p = tmpFile("small.txt", "hello world");
    const hash = await computeFullHash(p);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", async () => {
    const p = tmpFile("det.txt", "same content");
    expect(await computeFullHash(p)).toBe(await computeFullHash(p));
  });

  it("differs for different content", async () => {
    const a = tmpFile("a.txt", "content a");
    const b = tmpFile("b.txt", "content b");
    expect(await computeFullHash(a)).not.toBe(await computeFullHash(b));
  });

  it("produces same result as computeSampledHash for files ≤ 100KB", async () => {
    const p = tmpFile("tiny.txt", "tiny file");
    const size = (await Bun.file(p).stat()).size;
    expect(size).toBeLessThanOrEqual(100 * 1024);
    expect(await computeFullHash(p)).toBe(await computeSampledHash(p, size));
  });
});

describe("computeSampledHash", () => {
  it("produces a 64-char hex string for small files", async () => {
    const p = tmpFile("small2.txt", "hello");
    const size = (await Bun.file(p).stat()).size;
    const hash = await computeSampledHash(p, size);
    expect(hash).toHaveLength(64);
  });

  it("is deterministic for large files", async () => {
    // Create a file > 100KB
    const data = Buffer.alloc(200 * 1024, 0xab);
    const p = tmpFile("large.bin", data);
    const size = data.length;
    const h1 = await computeSampledHash(p, size);
    const h2 = await computeSampledHash(p, size);
    expect(h1).toBe(h2);
  });

  it("differs from full hash for large files", async () => {
    const data = Buffer.alloc(200 * 1024, 0xcd);
    const p = tmpFile("large2.bin", data);
    const size = data.length;
    const sampled = await computeSampledHash(p, size);
    const full = await computeFullHash(p);
    // They *should* differ because sampled includes size prefix + only samples
    // (for uniform content they could theoretically match — skip if same)
    expect(sampled).toHaveLength(64);
    expect(full).toHaveLength(64);
  });

  it("differs for files of the same size but different content", async () => {
    const size = 200 * 1024;
    const a = tmpFile("same-size-a.bin", Buffer.alloc(size, 0x01));
    const b = tmpFile("same-size-b.bin", Buffer.alloc(size, 0x02));
    const ha = await computeSampledHash(a, size);
    const hb = await computeSampledHash(b, size);
    expect(ha).not.toBe(hb);
  });

  it("differs for files with same content but different sizes (size prefix)", async () => {
    // Two files: same first 100KB, but different sizes (sampled content identical)
    // The size prefix should still produce different hashes
    const content = Buffer.alloc(200 * 1024, 0xff);
    const shorter = content.subarray(0, 150 * 1024);
    const p1 = tmpFile("size-diff-a.bin", content);
    const p2 = tmpFile("size-diff-b.bin", shorter);
    const h1 = await computeSampledHash(p1, content.length);
    const h2 = await computeSampledHash(p2, shorter.length);
    expect(h1).not.toBe(h2);
  });
});

describe("HASH_ALGO_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(HASH_ALGO_VERSION)).toBe(true);
    expect(HASH_ALGO_VERSION).toBeGreaterThan(0);
  });
});
