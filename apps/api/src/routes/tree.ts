import { Hono } from "hono";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";

export const treeRouter = new Hono();

export interface TreeEntry {
  kind: "directory" | "file";
  id: number;
  name: string;
  path: string;
  sizeBytes: number;
  // directories only
  fileCount?: number;
  directFileCount?: number;
  // files only
  mtime?: string;
  sampledHash?: string | null;
}

export interface TreeResponse {
  diskId: number;
  parentId: number | null;
  parentPath: string | null;
  breadcrumb: Array<{ id: number | null; name: string; path: string }>;
  totalSizeBytes: number;
  entries: TreeEntry[];
}

/**
 * GET /api/disks/:id/tree
 * Optional query: ?parentId=<directoryId> or ?parentPath=<absoluteDirectoryPath>
 *
 * Returns all direct children (subdirectories + files) of the given directory,
 * sorted largest-first. If parentId is omitted, returns the root directory's
 * children.
 *
 * Breadcrumb is always included so the UI can render navigation.
 */
treeRouter.get("/", (c) => {
  const diskId = Number(c.req.param("id"));
  const rawParentId = c.req.query("parentId");
  const rawParentPath = c.req.query("parentPath");

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  // Resolve the target directory
  let parentId: number | null = null;
  let parentPath: string | null = null;
  let totalSizeBytes = 0;

  if (rawParentPath !== undefined) {
    const dir = db
      .prepare("SELECT id, path, total_size_bytes FROM directories WHERE path = ? AND disk_id = ?")
      .get(rawParentPath, diskId) as { id: number; path: string; total_size_bytes: number } | null;
    if (!dir) return c.json({ error: "Directory not found" }, 404);
    parentId = dir.id;
    parentPath = dir.path;
    totalSizeBytes = dir.total_size_bytes;
  } else if (rawParentId !== undefined) {
    parentId = Number(rawParentId);
    const dir = db
      .prepare("SELECT id, path, total_size_bytes FROM directories WHERE id = ? AND disk_id = ?")
      .get(parentId, diskId) as { id: number; path: string; total_size_bytes: number } | null;
    if (!dir) return c.json({ error: "Directory not found" }, 404);
    parentPath = dir.path;
    totalSizeBytes = dir.total_size_bytes;
  } else {
    // Root: use the disk's mount path as the root directory
    const root = db
      .prepare(
        "SELECT id, path, total_size_bytes FROM directories WHERE disk_id = ? AND parent_id IS NULL ORDER BY id ASC LIMIT 1"
      )
      .get(diskId) as { id: number; path: string; total_size_bytes: number } | null;

    if (!root) {
      // Disk has never been scanned
      return c.json({
        diskId,
        parentId: null,
        parentPath: null,
        breadcrumb: [{ id: null, name: disk.label ?? "Disk", path: "" }],
        totalSizeBytes: 0,
        entries: [],
      } satisfies TreeResponse);
    }

    parentId = root.id;
    parentPath = root.path;
    totalSizeBytes = root.total_size_bytes;
  }

  // Subdirectories
  const subdirs = db
    .prepare(
      `SELECT id, name, path, total_size_bytes, file_count, direct_file_count
       FROM directories
       WHERE disk_id = ? AND parent_id = ?
       ORDER BY total_size_bytes DESC`
    )
    .all(diskId, parentId) as Array<{
      id: number;
      name: string;
      path: string;
      total_size_bytes: number;
      file_count: number;
      direct_file_count: number;
    }>;

  // Direct files in this directory
  const files = db
    .prepare(
      `SELECT id, name, path, size_bytes, mtime, sampled_hash
       FROM files
       WHERE disk_id = ? AND directory_id = ?
       ORDER BY size_bytes DESC`
    )
    .all(diskId, parentId) as Array<{
      id: number;
      name: string;
      path: string;
      size_bytes: number;
      mtime: string;
      sampled_hash: string | null;
    }>;

  const entries: TreeEntry[] = [
    ...subdirs.map((d) => ({
      kind: "directory" as const,
      id: d.id,
      name: d.name,
      path: d.path,
      sizeBytes: d.total_size_bytes,
      fileCount: d.file_count,
      directFileCount: d.direct_file_count,
    })),
    ...files.map((f) => ({
      kind: "file" as const,
      id: f.id,
      name: f.name,
      path: f.path,
      sizeBytes: f.size_bytes,
      mtime: f.mtime,
      sampledHash: f.sampled_hash,
    })),
  ].sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Build breadcrumb by walking up via parent_id
  const breadcrumb = buildBreadcrumb(db, diskId, parentId, disk.label);

  return c.json({
    diskId,
    parentId,
    parentPath,
    breadcrumb,
    totalSizeBytes,
    entries,
  } satisfies TreeResponse);
});

function buildBreadcrumb(
  db: ReturnType<typeof getDb>,
  diskId: number,
  dirId: number,
  diskLabel: string | null
): Array<{ id: number | null; name: string; path: string }> {
  const crumbs: Array<{ id: number | null; name: string; path: string }> = [];
  let current: number | null = dirId;

  while (current !== null) {
    const row = db
      .prepare("SELECT id, name, path, parent_id FROM directories WHERE id = ? AND disk_id = ?")
      .get(current, diskId) as { id: number; name: string; path: string; parent_id: number | null } | null;
    if (!row) break;
    crumbs.unshift({ id: row.id, name: row.name, path: row.path });
    current = row.parent_id;
  }

  // The root directory (parent_id IS NULL) represents the disk itself.
  // Use the disk label as its display name so the breadcrumb reads
  // "MyDisk / Photos / …" instead of "MyDisk / MyDisk / …".
  if (crumbs.length > 0 && crumbs[0].id !== null) {
    crumbs[0].name = diskLabel ?? crumbs[0].name;
  }

  return crumbs;
}
