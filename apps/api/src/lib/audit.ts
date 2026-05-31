import type { Database } from "bun:sqlite";

/**
 * Audit logging for revertible writes.
 *
 * Every mutating HTTP endpoint should call `recordAudit` after the underlying
 * DB change but inside the same transaction. The row captures enough
 * before/after state to reverse the operation later. See migration
 * 0024_audit_log.sql for the schema and field conventions.
 */

export type Actor = "ui" | "agent" | "system";

export interface AuditEntry {
  action: string;
  actor: Actor;
  userAgent?: string | null;
  diskId?: number | null;
  targetKind?: string | null;
  targetId?: number | null;
  targetPath?: string | null;
  before?: unknown;
  after?: unknown;
  notes?: string | null;
  metadata?: unknown;
  revertible?: boolean;
}

/**
 * Classify the actor based on the User-Agent header.
 *
 * - Real browsers send `Mozilla/...` — treat as `ui`.
 * - Anything else (curl, fetch, SDK clients, scripts) — treat as `agent`.
 * - Callers from background jobs without a request context pass `system` directly.
 */
export function classifyActor(userAgent: string | null | undefined): Actor {
  if (!userAgent) return "agent";
  return userAgent.includes("Mozilla/") ? "ui" : "agent";
}

function toJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

/**
 * Insert a single audit_log row. Returns the row id.
 *
 * Always call this from within the same transaction that performed the
 * underlying state change, so audit + change either both land or neither does.
 */
export function recordAudit(db: Database, entry: AuditEntry): number {
  const result = db
    .prepare(
      `INSERT INTO audit_log (
         action, actor, user_agent, disk_id,
         target_kind, target_id, target_path,
         before_json, after_json, notes, metadata_json, revertible
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      entry.action,
      entry.actor,
      entry.userAgent ?? null,
      entry.diskId ?? null,
      entry.targetKind ?? null,
      entry.targetId ?? null,
      entry.targetPath ?? null,
      toJson(entry.before),
      toJson(entry.after),
      entry.notes ?? null,
      toJson(entry.metadata),
      entry.revertible === false ? 0 : 1
    ) as { id: number };
  return result.id;
}

/**
 * Look up an audit entry by id. Returns null if not found.
 */
export interface AuditRow {
  id: number;
  createdAt: string;
  action: string;
  actor: Actor;
  userAgent: string | null;
  diskId: number | null;
  targetKind: string | null;
  targetId: number | null;
  targetPath: string | null;
  before: unknown;
  after: unknown;
  notes: string | null;
  metadata: unknown;
  revertible: boolean;
  revertedByAuditId: number | null;
}

function parseJson(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function rowToAudit(raw: {
  id: number;
  created_at: string;
  action: string;
  actor: Actor;
  user_agent: string | null;
  disk_id: number | null;
  target_kind: string | null;
  target_id: number | null;
  target_path: string | null;
  before_json: string | null;
  after_json: string | null;
  notes: string | null;
  metadata_json: string | null;
  revertible: number;
  reverted_by_audit_id: number | null;
}): AuditRow {
  return {
    id: raw.id,
    createdAt: raw.created_at,
    action: raw.action,
    actor: raw.actor,
    userAgent: raw.user_agent,
    diskId: raw.disk_id,
    targetKind: raw.target_kind,
    targetId: raw.target_id,
    targetPath: raw.target_path,
    before: parseJson(raw.before_json),
    after: parseJson(raw.after_json),
    notes: raw.notes,
    metadata: parseJson(raw.metadata_json),
    revertible: raw.revertible === 1,
    revertedByAuditId: raw.reverted_by_audit_id,
  };
}

export function getAuditById(db: Database, id: number): AuditRow | null {
  const row = db
    .prepare(`SELECT * FROM audit_log WHERE id = ?`)
    .get(id) as Parameters<typeof rowToAudit>[0] | null;
  return row ? rowToAudit(row) : null;
}

export { rowToAudit };
