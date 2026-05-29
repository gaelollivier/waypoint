import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createTestApp, insertDisk, type TestContext } from "./helpers";

describe("media routes", () => {
  let ctx: TestContext;
  let root: string;

  beforeEach(() => {
    ctx = createTestApp();
    root = mkdtempSync(path.join(tmpdir(), "waypoint-media-"));
    // Register the temp root as a mounted disk so paths under it are allowed.
    insertDisk(ctx.db, { mount_path: root, is_connected: 1 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function get(pathQuery: string, headers?: Record<string, string>) {
    const url = `/api/media?path=${encodeURIComponent(pathQuery)}`;
    return ctx.app.request(url, { method: "GET", headers });
  }

  it("rejects missing path", async () => {
    const res = await ctx.app.request("/api/media", { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("rejects relative paths", async () => {
    const res = await get("relative/path.jpg");
    expect(res.status).toBe(400);
  });

  it("rejects paths outside a registered mount", async () => {
    const res = await get("/etc/passwd");
    expect(res.status).toBe(403);
  });

  it("rejects path traversal attempts", async () => {
    // After normalisation this becomes /etc/passwd, which is outside the mount.
    const traversed = `${root}/../../../etc/passwd`;
    const res = await get(traversed);
    expect(res.status).toBe(403);
  });

  it("404s when the file does not exist on disk", async () => {
    const res = await get(path.join(root, "missing.jpg"));
    expect(res.status).toBe(404);
  });

  it("streams the full file with correct content type for jpg", async () => {
    const file = path.join(root, "photo.jpg");
    writeFileSync(file, "x".repeat(1024));
    const res = await get(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("1024");
    expect((res.headers.get("Content-Disposition") ?? "").startsWith("inline")).toBe(true);
    const body = await res.text();
    expect(body.length).toBe(1024);
  });

  it("sets attachment disposition with download=1", async () => {
    const file = path.join(root, "video.mp4");
    writeFileSync(file, "data");
    const url = `/api/media?path=${encodeURIComponent(file)}&download=1`;
    const res = await ctx.app.request(url, { method: "GET" });
    expect(res.status).toBe(200);
    expect((res.headers.get("Content-Disposition") ?? "").startsWith("attachment")).toBe(true);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
  });

  it("responds 206 with Content-Range for a Range request", async () => {
    const file = path.join(root, "video.mp4");
    const buf = Buffer.alloc(1000);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
    writeFileSync(file, buf);

    const res = await get(file, { Range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(100);
    expect(body[99]).toBe(199);
  });

  it("supports open-ended ranges (bytes=N-)", async () => {
    const file = path.join(root, "video.mp4");
    writeFileSync(file, Buffer.alloc(500, 7));
    const res = await get(file, { Range: "bytes=200-" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 200-499/500");
    expect(res.headers.get("Content-Length")).toBe("300");
  });

  it("returns 416 for an out-of-bounds range", async () => {
    const file = path.join(root, "video.mp4");
    writeFileSync(file, Buffer.alloc(50));
    const res = await get(file, { Range: "bytes=999-1000" });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */50");
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const file = path.join(root, "weird.xyz");
    writeFileSync(file, "data");
    const res = await get(file);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("serves files under a nested directory inside the mount", async () => {
    mkdirSync(path.join(root, "sub", "nested"), { recursive: true });
    const file = path.join(root, "sub", "nested", "x.png");
    writeFileSync(file, "data");
    const res = await get(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});
