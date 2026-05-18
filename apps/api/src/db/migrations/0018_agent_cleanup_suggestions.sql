-- Agent-driven cleanup suggestion tables.
--
-- Two new tables and two supporting indexes:
--
--   agent_notes          — one freeform markdown blob per disk. The LLM agent
--                          stores its inferred keep/delete rules here so the
--                          rule set survives across sessions.
--
--   cleanup_suggestions  — one row per proposed (keep_path, delete_paths) for
--                          a content_hash. Keyed by *paths*, not scan-snapshot
--                          file_ids, so suggestions survive re-scans and
--                          re-runs of duplicate detection (the user re-scans
--                          after a cleanup session to refresh state; pending
--                          suggestions must still apply against the new scan).
--
-- A pending suggestion is resolved against the latest completed duplicate
-- detection job at GET time: paths are looked up in `files` for that scan,
-- and the surviving full_hash is compared with `content_hash`. If a path is
-- gone or the hash drifted, the suggestion is reported as `stale` to the UI
-- (computed at read time; not a stored status).

CREATE TABLE agent_notes (
  disk_id    INTEGER PRIMARY KEY REFERENCES disks(id),
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE cleanup_suggestions (
  id           INTEGER PRIMARY KEY,
  disk_id      INTEGER NOT NULL REFERENCES disks(id),
  content_hash TEXT    NOT NULL,
  keep_path    TEXT    NOT NULL,
  delete_paths TEXT    NOT NULL,                   -- JSON array of absolute paths
  size_bytes   INTEGER NOT NULL,                   -- per-file size, used for sort + display
  rationale    TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  applied_at   TEXT,
  dismissed_at TEXT
);

-- Listing pages filter on (disk_id, status) and sort by wasted bytes desc
-- (= size_bytes * delete count, but size_bytes is monotonic enough as a sort key).
CREATE INDEX cleanup_suggestions_list
  ON cleanup_suggestions (disk_id, status, size_bytes DESC);

-- Only one pending suggestion per (disk, content_hash). Re-submitting for the
-- same content_hash replaces the previous pending row; applied/dismissed rows
-- are unconstrained so the audit trail can accumulate.
CREATE UNIQUE INDEX cleanup_suggestions_pending_uniq
  ON cleanup_suggestions (disk_id, content_hash)
  WHERE status = 'pending';

-- Suggestion resolution needs `file_id → duplicate_group_id`; the existing
-- index on duplicate_group_files is only on group_id, so this is a deliberate
-- new index (RULE: deliberate index story).
CREATE INDEX duplicate_group_files_file
  ON duplicate_group_files (file_id);
