import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";

export const filesRouter = new Hono();

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileRow {
  id: number;
  scanId: number;
  directoryId: number;
  name: string;
  path: string;
  sizeBytes: number;
  mtime: string;
  sampledHash: string | null;
  fullHash: string | null;
  media?: {
    capturedAtUnix: number | null;
    datetimeOriginal: string | null;
    datetimeSource: string | null;
    durationSeconds: number | null;
    make: string | null;
    model: string | null;
  };
}

export interface FilesResponse {
  diskId: number;
  scanId: number;
  entries: FileRow[];
  truncated: boolean;
  nextCursor: string | null;
}

interface RawFileRow {
  id: number;
  scan_id: number;
  directory_id: number;
  name: string;
  path: string;
  size_bytes: number;
  mtime: string;
  sampled_hash: string | null;
  full_hash: string | null;
  // media join (nullable when not joined or no metadata row)
  captured_at_unix: number | null;
  datetime_original: string | null;
  datetime_source: string | null;
  duration_seconds: number | null;
  make: string | null;
  model: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50_000;
const MAX_HARD_LIMIT = 1_000_000; // explicit limit=0 maps to this

const SORTABLE_COLUMNS = {
  id: "f.id",
  size: "f.size_bytes",
  path: "f.path",
  name: "f.name",
  mtime: "f.mtime",
  capturedAt: "mm.captured_at_unix",
} as const;

type SortKey = keyof typeof SORTABLE_COLUMNS;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseInt32(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseFloat64(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseList(s: string | undefined): string[] | null {
  if (s === undefined || s === "") return null;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function resolveLatestScanId(db: Database, diskId: number): number | null {
  const row = db
    .prepare("SELECT last_scan_job_id AS id FROM disks WHERE id = ?")
    .get(diskId) as { id: number | null } | null;
  if (!row || row.id === null) return null;
  return row.id;
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

function escapeLike(s: string): string {
  // Use `\` as escape; we always pass ESCAPE '\\' in the LIKE clause.
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

interface ParsedFilters {
  scanId: number;
  pathPrefix: string | null;
  name: string | null; // LIKE pattern (caller may pass `%name%`)
  exts: string[] | null;
  sizeMin: number | null;
  sizeMax: number | null;
  sampledHash: string | null;
  fullHash: string | null;
  capturedFrom: number | null;
  capturedTo: number | null;
  durationMin: number | null;
  durationMax: number | null;
  make: string | null;
  model: string | null;
  hasMediaMetadata: boolean | null; // true=require, false=require absent, null=any
  sortKey: SortKey;
  sortDesc: boolean;
  limit: number;
  includeMedia: boolean;
  cursor: { v: string | number | null; id: number } | null;
}

function parseFilters(c: import("hono").Context, scanId: number): ParsedFilters | { error: string } {
  const q = c.req.query.bind(c.req);

  const sortRaw = (q("sort") ?? "id") as string;
  let sortKey: SortKey;
  let sortDesc = q("order") === "desc";
  if (sortRaw in SORTABLE_COLUMNS) {
    sortKey = sortRaw as SortKey;
  } else {
    return { error: `unknown sort: ${sortRaw}` };
  }
  // size defaults to desc when no order is given
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

  const hasMediaRaw = q("hasMediaMetadata");
  let hasMediaMetadata: boolean | null = null;
  if (hasMediaRaw === "true" || hasMediaRaw === "1") hasMediaMetadata = true;
  else if (hasMediaRaw === "false" || hasMediaRaw === "0") hasMediaMetadata = false;

  return {
    scanId,
    pathPrefix: q("pathPrefix") ?? null,
    name: q("name") ?? null,
    exts: parseList(q("ext")),
    sizeMin: parseInt32(q("sizeMin")),
    sizeMax: parseInt32(q("sizeMax")),
    sampledHash: q("sampledHash") ?? null,
    fullHash: q("fullHash") ?? null,
    capturedFrom: parseInt32(q("capturedFrom")),
    capturedTo: parseInt32(q("capturedTo")),
    durationMin: parseFloat64(q("durationMin")),
    durationMax: parseFloat64(q("durationMax")),
    make: q("make") ?? null,
    model: q("model") ?? null,
    hasMediaMetadata,
    sortKey,
    sortDesc,
    limit,
    includeMedia: q("include") === "media",
    cursor,
  };
}

function needsMediaJoin(f: ParsedFilters): boolean {
  return (
    f.includeMedia ||
    f.capturedFrom !== null ||
    f.capturedTo !== null ||
    f.durationMin !== null ||
    f.durationMax !== null ||
    f.make !== null ||
    f.model !== null ||
    f.hasMediaMetadata !== null ||
    f.sortKey === "capturedAt"
  );
}

function buildWhere(f: ParsedFilters): {
  sql: string;
  params: Array<string | number>;
} {
  const conds: string[] = ["f.scan_id = ?"];
  const params: Array<string | number> = [f.scanId];

  if (f.pathPrefix !== null) {
    const stripped = f.pathPrefix.replace(/\/+$/, "");
    const escaped = escapeLike(stripped);
    conds.push(`(f.path = ? OR f.path LIKE ? ESCAPE '\\')`);
    params.push(stripped, escaped + "/%");
  }
  if (f.name !== null) {
    conds.push(`f.name LIKE ? ESCAPE '\\'`);
    params.push(f.name);
  }
  if (f.exts !== null && f.exts.length > 0) {
    const parts = f.exts.map(() => `f.name LIKE ? ESCAPE '\\'`).join(" OR ");
    conds.push(`(${parts})`);
    for (const e of f.exts) {
      const clean = e.startsWith(".") ? e.slice(1) : e;
      params.push("%." + escapeLike(clean));
    }
  }
  if (f.sizeMin !== null) {
    conds.push(`f.size_bytes >= ?`);
    params.push(f.sizeMin);
  }
  if (f.sizeMax !== null) {
    conds.push(`f.size_bytes <= ?`);
    params.push(f.sizeMax);
  }
  if (f.sampledHash !== null) {
    conds.push(`f.sampled_hash = ?`);
    params.push(f.sampledHash);
  }
  if (f.fullHash !== null) {
    conds.push(`f.full_hash = ?`);
    params.push(f.fullHash);
  }
  if (f.capturedFrom !== null) {
    conds.push(`mm.captured_at_unix >= ?`);
    params.push(f.capturedFrom);
  }
  if (f.capturedTo !== null) {
    conds.push(`mm.captured_at_unix <= ?`);
    params.push(f.capturedTo);
  }
  if (f.durationMin !== null) {
    conds.push(`mm.duration_seconds >= ?`);
    params.push(f.durationMin);
  }
  if (f.durationMax !== null) {
    conds.push(`mm.duration_seconds <= ?`);
    params.push(f.durationMax);
  }
  if (f.make !== null) {
    conds.push(`mm.make = ?`);
    params.push(f.make);
  }
  if (f.model !== null) {
    conds.push(`mm.model = ?`);
    params.push(f.model);
  }
  if (f.hasMediaMetadata === true) {
    conds.push(`mm.file_id IS NOT NULL`);
  } else if (f.hasMediaMetadata === false) {
    conds.push(`mm.file_id IS NULL`);
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
  // Keyset pagination: ((sort_col, id) cmp (?, ?))
  // Use COALESCE so NULLs sort consistently as "smallest".
  if (f.cursor.v === null) {
    // After a null value: in asc, next is non-null; in desc, no more.
    if (f.sortDesc) {
      // already past everything, but keep DB happy
      where.sql += ` AND f.id ${cmp} ?`;
      where.params.push(f.cursor.id);
    } else {
      where.sql += ` AND (${col} IS NOT NULL OR (${col} IS NULL AND f.id ${cmp} ?))`;
      where.params.push(f.cursor.id);
    }
  } else {
    where.sql += ` AND (${col} ${cmp} ? OR (${col} = ? AND f.id ${cmp} ?))`;
    where.params.push(f.cursor.v, f.cursor.v, f.cursor.id);
  }
}

function buildOrderBy(f: ParsedFilters): string {
  const col = SORTABLE_COLUMNS[f.sortKey];
  const dir = f.sortDesc ? "DESC" : "ASC";
  return `${col} ${dir}, f.id ${dir}`;
}

function fromAndSelect(joinMedia: boolean, includeMedia: boolean): {
  select: string;
  from: string;
} {
  const baseCols = [
    "f.id",
    "f.scan_id",
    "f.directory_id",
    "f.name",
    "f.path",
    "f.size_bytes",
    "f.mtime",
    "f.sampled_hash",
    "f.full_hash",
  ];
  const mediaCols = [
    "mm.captured_at_unix",
    "mm.datetime_original",
    "mm.datetime_source",
    "mm.duration_seconds",
    "mm.make",
    "mm.model",
  ];

  // Always select the keyset-sort column from mm when joined so cursor encode
  // works. If no join, NULLs are returned for those columns.
  const cols = baseCols.concat(
    joinMedia
      ? mediaCols
      : mediaCols.map((c) => `NULL AS ${c.split(".").pop()}`)
  );

  const select = `SELECT ${cols.join(", ")}`;
  const from = joinMedia
    ? `FROM files f LEFT JOIN media_metadata mm ON mm.file_id = f.id`
    : `FROM files f`;
  return { select, from };
}

function toFileRow(raw: RawFileRow, includeMedia: boolean): FileRow {
  const row: FileRow = {
    id: raw.id,
    scanId: raw.scan_id,
    directoryId: raw.directory_id,
    name: raw.name,
    path: raw.path,
    sizeBytes: raw.size_bytes,
    mtime: raw.mtime,
    sampledHash: raw.sampled_hash,
    fullHash: raw.full_hash,
  };
  if (includeMedia) {
    row.media = {
      capturedAtUnix: raw.captured_at_unix,
      datetimeOriginal: raw.datetime_original,
      datetimeSource: raw.datetime_source,
      durationSeconds: raw.duration_seconds,
      make: raw.make,
      model: raw.model,
    };
  }
  return row;
}

function sortValue(raw: RawFileRow, key: SortKey): string | number | null {
  switch (key) {
    case "id":
      return raw.id;
    case "size":
      return raw.size_bytes;
    case "path":
      return raw.path;
    case "name":
      return raw.name;
    case "mtime":
      return raw.mtime;
    case "capturedAt":
      return raw.captured_at_unix;
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/disks/:id/files
 *
 * Query all files in a scan snapshot. See docs/agent-api.md for the full
 * filter / sort / pagination contract.
 */
filesRouter.get("/", (c) => {
  const diskId = Number(c.req.param("id"));
  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const scanIdParam = parseInt32(c.req.query("scanId"));
  const scanId = scanIdParam ?? resolveLatestScanId(db, diskId);
  if (scanId === null) return c.json({ error: "Disk has no scans" }, 400);

  const parsed = parseFilters(c, scanId);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const joinMedia = needsMediaJoin(parsed);
  const where = buildWhere(parsed);
  applyCursor(parsed, where);
  const { select, from } = fromAndSelect(joinMedia, parsed.includeMedia);
  const sql = `${select} ${from} WHERE ${where.sql} ORDER BY ${buildOrderBy(parsed)} LIMIT ?`;
  // Fetch limit+1 to know whether more results exist.
  const rows = db.prepare(sql).all(...where.params, parsed.limit + 1) as RawFileRow[];

  let truncated = false;
  let nextCursor: string | null = null;
  if (rows.length > parsed.limit) {
    truncated = true;
    rows.pop();
    const tail = rows[rows.length - 1];
    nextCursor = encodeCursor({
      v: sortValue(tail, parsed.sortKey),
      id: tail.id,
    });
  }

  const body: FilesResponse = {
    diskId,
    scanId,
    entries: rows.map((r) => toFileRow(r, parsed.includeMedia)),
    truncated,
    nextCursor,
  };
  return c.json(body);
});

/**
 * GET /api/disks/:id/files/by-path?path=<absolute>&include=media
 */
filesRouter.get("/by-path", (c) => {
  const diskId = Number(c.req.param("id"));
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const scanIdParam = parseInt32(c.req.query("scanId"));
  const scanId = scanIdParam ?? resolveLatestScanId(db, diskId);
  if (scanId === null) return c.json({ error: "Disk has no scans" }, 400);

  const includeMedia = c.req.query("include") === "media";

  const { select, from } = fromAndSelect(true, includeMedia);
  const row = db
    .prepare(`${select} ${from} WHERE f.scan_id = ? AND f.path = ? LIMIT 1`)
    .get(scanId, path) as RawFileRow | null;
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json({ diskId, scanId, file: toFileRow(row, includeMedia) });
});

/**
 * GET /api/disks/:id/files/:fileId?include=media
 *
 * Mostly useful for stable id-based lookups across a session.
 */
filesRouter.get("/:fileId{[0-9]+}", (c) => {
  const diskId = Number(c.req.param("id"));
  const fileId = Number(c.req.param("fileId"));

  const db = getDb();
  const disk = getDiskById(db, diskId);
  if (!disk) return c.json({ error: "Disk not found" }, 404);

  const includeMedia = c.req.query("include") === "media";
  const { select, from } = fromAndSelect(true, includeMedia);

  const row = db
    .prepare(`${select} ${from} WHERE f.id = ? AND f.disk_id = ? LIMIT 1`)
    .get(fileId, diskId) as RawFileRow | null;
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json({ diskId, scanId: row.scan_id, file: toFileRow(row, includeMedia) });
});
