-- Audit log for revertible writes.
--
-- Every mutating HTTP endpoint records a row here capturing enough state
-- (before + after) to reverse the operation later. This is in addition to —
-- not a replacement for — the per-feature history we already keep
-- (`jobs`, `deleted_files`, `deleted_directories`, `cleanup_suggestion_*`).
-- Those tables describe *what* the system did; this table describes *who*
-- asked for it, *when*, and *exactly what state changed*, so a generic
-- revert UI can be built on top.
--
-- Conventions:
--
-- - `action`   stable string ID (snake_case) of the operation. Lowercase.
-- - `actor`    `'ui'` (request looks like a real browser), `'agent'` (other
--              clients hitting the API), `'system'` (background work that
--              has no request context). UA classification happens in
--              lib/audit.ts.
-- - `target_*` identify the row this audit refers to. `target_kind` is a
--              free-form string; `target_id` is the affected row's PK when
--              we have one, `target_path` is set for file/dir-targeting
--              actions (matches files.path / directories.path).
-- - `before_json` / `after_json` JSON snapshots: prior state for
--              updates/deletes (NULL on creates) and new state for
--              creates/updates (NULL on deletes). Snapshots are aimed at
--              revertibility, not full diffability, so feel free to record
--              only the fields needed to reconstruct the prior state.
-- - `revertible` is the author's claim; defaults to 1. Set to 0 when the
--              underlying op cannot be reversed (eg the destination of a
--              destructive cleanup was the canonical copy).
-- - `reverted_by_audit_id` lets a revert link back to the original; the
--              two rows together form a chain.
-- - `metadata_json` is free-form structured context (eg the duplicate
--              group id, the suggestion id, comparison member ids).

CREATE TABLE audit_log (
  id                    INTEGER PRIMARY KEY,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  action                TEXT    NOT NULL,
  actor                 TEXT    NOT NULL CHECK (actor IN ('ui', 'agent', 'system')),
  user_agent            TEXT,
  disk_id               INTEGER REFERENCES disks(id),
  target_kind           TEXT,
  target_id             INTEGER,
  target_path           TEXT,
  before_json           TEXT,
  after_json            TEXT,
  revertible            INTEGER NOT NULL DEFAULT 1 CHECK (revertible IN (0, 1)),
  reverted_by_audit_id  INTEGER REFERENCES audit_log(id),
  notes                 TEXT,
  metadata_json         TEXT
);

CREATE INDEX audit_log_created
  ON audit_log (created_at);

CREATE INDEX audit_log_disk_created
  ON audit_log (disk_id, created_at)
  WHERE disk_id IS NOT NULL;

CREATE INDEX audit_log_action_created
  ON audit_log (action, created_at);

CREATE INDEX audit_log_target
  ON audit_log (target_kind, target_id)
  WHERE target_id IS NOT NULL;

CREATE INDEX audit_log_target_path
  ON audit_log (target_path)
  WHERE target_path IS NOT NULL;
