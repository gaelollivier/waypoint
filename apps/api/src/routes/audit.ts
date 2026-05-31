import { Hono } from "hono";
import { getDb } from "../db/client";
import { rowToAudit, type AuditRow } from "../lib/audit";

export const auditRouter = new Hono();

const DEFAULT_LIMIT = 200;
const MAX_HARD_LIMIT = 50_000;

function parseInt32(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

function decodeCursor(s: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof parsed?.id !== "number") return null;
    return parsed.id;
  } catch {
    return null;
  }
}

/**
 * GET /api/audit
 *
 * List audit_log entries. Newest first by default. Filters:
 *   ?diskId      — only entries with this disk_id
 *   ?action      — only entries with this action (exact match)
 *   ?targetKind  — only entries with this target_kind
 *   ?targetId    — only entries with this target_id
 *   ?since       — ISO8601 lower bound on created_at
 *   ?until       — ISO8601 upper bound on created_at
 *   ?limit       — default 200, max 50000; 0 = max
 *   ?cursor      — opaque cursor returned in `nextCursor`
 */
auditRouter.get("/", (c) => {
  const q = c.req.query.bind(c.req);

  const conds: string[] = [];
  const params: Array<string | number> = [];

  const diskId = parseInt32(q("diskId"));
  if (diskId !== null) {
    conds.push("disk_id = ?");
    params.push(diskId);
  }
  if (q("action")) {
    conds.push("action = ?");
    params.push(q("action") as string);
  }
  if (q("targetKind")) {
    conds.push("target_kind = ?");
    params.push(q("targetKind") as string);
  }
  const targetId = parseInt32(q("targetId"));
  if (targetId !== null) {
    conds.push("target_id = ?");
    params.push(targetId);
  }
  if (q("since")) {
    conds.push("created_at >= ?");
    params.push(q("since") as string);
  }
  if (q("until")) {
    conds.push("created_at <= ?");
    params.push(q("until") as string);
  }

  const cursorRaw = q("cursor");
  if (cursorRaw) {
    const cursorId = decodeCursor(cursorRaw);
    if (cursorId === null) return c.json({ error: "invalid cursor" }, 400);
    conds.push("id < ?");
    params.push(cursorId);
  }

  const limitRaw = parseInt32(q("limit"));
  let limit: number;
  if (limitRaw === null) limit = DEFAULT_LIMIT;
  else if (limitRaw === 0) limit = MAX_HARD_LIMIT;
  else if (limitRaw < 0) return c.json({ error: "limit must be >= 0" }, 400);
  else limit = Math.min(limitRaw, MAX_HARD_LIMIT);

  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1) as Array<Parameters<typeof rowToAudit>[0]>;

  let truncated = false;
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    truncated = true;
    rows.pop();
    nextCursor = encodeCursor(rows[rows.length - 1].id);
  }

  const entries: AuditRow[] = rows.map(rowToAudit);
  return c.json({ entries, truncated, nextCursor });
});

/**
 * GET /api/audit/:id — single entry lookup.
 */
auditRouter.get("/:id{[0-9]+}", (c) => {
  const id = Number(c.req.param("id"));
  const row = getDb()
    .prepare(`SELECT * FROM audit_log WHERE id = ?`)
    .get(id) as Parameters<typeof rowToAudit>[0] | null;
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(rowToAudit(row));
});
