import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";

export const directoriesRouter = new Hono();

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DirectoryRow {
  id: number;
  scanId: number;
  parentId: number | null;
  name: string;
  path: string;
  totalSizeBytes: number;
  fileCount: number;
  directFileCount: number;
  depth: number;
}

export interface DirectoriesResponse {
  diskId: number;
  scanId: number;
  entries: DirectoryRow[];
  truncated: boolean;
  nextCursor: string | null;
}

interface RawDirRow {
  id: number;
  scan_id: number;
  parent_id: number | null;
  name: string;
  path: string;
  total_size_bytes: number;
  file_count: number;
  direct_file_count: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50_000;
const MAX_HARD_LIMIT = 1_000_000;

const SORTABLE_COLUMNS = {
  id: "d.id",
  size: "d.total_size_bytes",
  fileCount: "d.file_count",
  path: "d.path",
  name: "d.name",
} as const;

type SortKey = keyof typeof SORTABLE_COLUMNS;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseInt32(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function resolveLatestScanId(db: Database, diskId: number): number | null {
  const row = db
    .prepare("SELECT last_scan_job_id AS id FROM disks WHERE id = ?")
    .get(diskId) as { id: number | null } | null;
  if (!row || row.id === null) return null;
  return row.id;
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function encodeCursor(payload: {
  v: string | number | null;
  id: number;
}): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(s: string): { v: string | number | null; id: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.id !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function pathDepth(p: string): number {
  // Depth measured in `/` segments, ignoring leading slash and trailing slash.
  // Disk root (e.g. "/Volumes/Foo") = 0.
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return 0;
  const slashes = (trimmed.match(/\//g) ?? []).length;
  // /Volumes/Foo has 2 slashes but is depth 0 (it's the disk root).
  // Subtract the depth of the disk's mount path. We do this in SQL via
  // (LENGTH(path) - LENGTH(REPLACE(path,'/',''))) - rootDepth.
  return slashes;
}

interface ParsedFilters {
  scanId: number;
  pathPrefix: string | null;
  parentPath: string | null;
  name: string | null;
  minDepth: number | null;
  maxDepth: number | null;
  sizeMin: number | null;
  sortKey: SortKey;
  sortDesc: boolean;
  limit: number;
  cursor: { v: string | number | null; id: number } | null;
}

function parseFilters(c: import("hono").Context, scanId: number): ParsedFilters | { error: string } {
  const q = c.req.query.bind(c.req);

  const sortRaw = (q("sort") ?? "id") as string;
  if (!(sortRaw in SORTABLE_COLUMNS)) {
    return { error: `unknown sort: ${sortRaw}` };
  }
  const sortKey = sortRaw as SortKey;
  let sortDesc = q("order") === "desc";
  if (sortKey === "size" && q("order") === undefined) sortDesc = true;

  const limitRaw = parseInt32(q("limit"));
  let limit: number;
  if (limitRaw === null) limit = DEFAULT_LIMIT;
  else if (limitRaw === 0) limit = MAX_HARD_LIMIT;
  else if (limitRaw < 0) return { error: "limit must be >= 0" };
  else limit = Math.min(limitRaw, MAX_HARD_LIMIT);

  const cursorRaw = q("cursor");
  let cursor: ParsedFilters["cursor"] = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (cursor === null) return { error: "invalid cursor" };
  }

  return {
    scanId,
    pathPrefix: q("pathPrefix") ?? null,
    parentPath: q("parentPath") ?? null,
    name: q("name") ?? null,
    minDepth: parseInt32(q("minDepth")),
    maxDepth: parseInt32(q("maxDepth")),
    sizeMin: parseInt32(q("sizeMin")),
    sortKey,
    sortDesc,
    limit,
    cursor,
  };
}

function buildWhere(f: ParsedFilters, rootPath: string | null): {
  sql: string;
  params: Array<string | number>;
} {
  const conds: string[] = ["d.scan_id = ?"];
  const params: Array<string | number> = [f.scanId];

  if (f.pathPrefix !== null) {
    const stripped = f.pathPrefix.replace(/\/+$/, "");
    const escaped = escapeLike(stripped);
    conds.push(`(d.path = ? OR d.path LIKE ? ESCAPE '\\')`);
    params.push(stripped, escaped + "/%");
  }
  if (f.parentPath !== null) {
    conds.push(
      `d.parent_id = (SELECT id FROM directories WHERE scan_id = ? AND path = ?)`
    );
    params.push(f.scanId, f.parentPath);
  }
  if (f.name !== null) {
    conds.push(`d.name LIKE ? ESCAPE '\\'`);
    params.push(f.name);
  }
  if (f.sizeMin !== null) {
    conds.push(`d.total_size_bytes >= ?`);
    params.push(f.sizeMin);
  }
  if (f.minDepth !== null || f.maxDepth !== null) {
    // Depth relative to disk root. Computed inline as the slash count of the
    // path minus the slash count of the root path. Root = depth 0.
    const rootSlashes = rootPath ? (rootPath.match(/\//g) ?? []).length : 0;
    if (f.minDepth !== null) {
      conds.push(
        `(LENGTH(d.path) - LENGTH(REPLACE(d.path, '/', ''))) - ? >= ?`
      );
      params.push(rootSlashes, f.minDepth);
    }
    if (f.maxDepth !== null) {
      conds.push(
        `(LENGTH(d.path) - LENGTH(REPLACE(d.path, '/', ''))) - ? <= ?`
      );
      params.push(rootSlashes, f.maxDepth);
    }
  }

  return { sql: conds.join(" AND "), params };
}

function applyCursor(
  f: ParsedFilters,
  where: { sql: string; params: Array<string | number> }
): void {
  if (f.cursor === null) return;
  const col = SORTABLE_COLUMNS[f.sortKey];
  const cmp = f.sortDesc ? "<" : ">";
  where.sql += ` AND (${col} ${cmp} ? OR (${col} = ? AND d.id ${cmp} ?))`;
  where.params.push(f.cursor.v ?? 0, f.cursor.v ?? 0, f.cursor.id);
}

function sortValue(raw: RawDirRow, key: SortKey): string | number | null {
  switch (key) {
    case "id":
      return raw.id;
    case "size":
      return raw.total_size_bytes;
    case "fileCount":
      return raw.file_count;
    case "path":
      return raw.path;
    case "name":
      return raw.name;
  }
}

function toDirRow(raw: RawDirRow, rootPath: string | null): DirectoryRow {
  const rootSlashes = rootPath ? (rootPath.match(/\//g) ?? []).length : 0;
  const slashes = (raw.path.match(/\//g) ?? []).length;
  return {
    id: raw.id,
    scanId: raw.scan_id,
    parentId: raw.parent_id,
    name: raw.name,
    path: raw.path,
    totalSizeBytes: raw.total_size_bytes,
    fileCount: raw.file_count,
    directFileCount: raw.direct_file_count,
    depth: slashes - rootSlashes,
  };
}

function findRootPath(db: Database, scanId: number): string | null {
  const r = db
    .prepare(
      "SELECT path FROM directories WHERE scan_id = ? AND parent_id IS NULL ORDER BY id ASC LIMIT 1"
    )
    .get(scanId) as { path: string } | null;
  return r?.path ?? null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/disks/:id/directories
 *
 * Query directories in a scan snapshot. Supports prefix, parent, name, and
 * depth filters. Useful for "list immediate subfolders of /Foo/YYYY/" without
 * loading the whole tree.
 */
directoriesRouter.get("/", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const scanIdParam = parseInt32(c.req.query("scanId"));
  const scanId = scanIdParam ?? resolveLatestScanId(db, diskId);
  if (scanId === null) return c.json({ error: "Disk has no scans" }, 400);

  const parsed = parseFilters(c, scanId);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const rootPath = findRootPath(db, scanId);
  const where = buildWhere(parsed, rootPath);
  applyCursor(parsed, where);

  const col = SORTABLE_COLUMNS[parsed.sortKey];
  const dir = parsed.sortDesc ? "DESC" : "ASC";
  const sql = `
    SELECT d.id, d.scan_id, d.parent_id, d.name, d.path,
           d.total_size_bytes, d.file_count, d.direct_file_count
      FROM directories d
     WHERE ${where.sql}
     ORDER BY ${col} ${dir}, d.id ${dir}
     LIMIT ?`;

  const rows = db.prepare(sql).all(...where.params, parsed.limit + 1) as RawDirRow[];

  let truncated = false;
  let nextCursor: string | null = null;
  if (rows.length > parsed.limit) {
    truncated = true;
    rows.pop();
    const tail = rows[rows.length - 1];
    nextCursor = encodeCursor({ v: sortValue(tail, parsed.sortKey), id: tail.id });
  }

  const body: DirectoriesResponse = {
    diskId,
    scanId,
    entries: rows.map((r) => toDirRow(r, rootPath)),
    truncated,
    nextCursor,
  };
  return c.json(body);
});
