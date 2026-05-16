import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { openPathInFinder } from "../fs/disk-writes";

export const systemRouter = new Hono();

// ---------------------------------------------------------------------------
// POST /api/system/open-in-finder
// Body: { path: string }
//
// Host-only convenience endpoint used by the local web UI. It opens Finder on
// the machine running the API server.
// ---------------------------------------------------------------------------
systemRouter.post("/open-in-finder", async (c) => {
  const body = await c.req.json<{ path?: string }>();
  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const targetPath = path.resolve(body.path);
  if (!path.isAbsolute(body.path)) {
    return c.json({ error: "path must be absolute" }, 400);
  }

  const db = getDb();
  const disks = db
    .prepare("SELECT mount_path FROM disks WHERE mount_path IS NOT NULL")
    .all() as Array<{ mount_path: string }>;

  const mountPaths = disks.map((disk) => disk.mount_path);
  const allowed = mountPaths.some((mp) => isPathWithinRoot(targetPath, mp));
  if (!allowed) {
    return c.json({ error: "path is not under a registered disk mount" }, 403);
  }

  try {
    openPathInFinder(targetPath, mountPaths);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const root = path.resolve(rootPath);
  const relative = path.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
