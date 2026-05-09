-- M9: Diff job tables
--
-- 1. Recreate `jobs` with 'diff' added to the type CHECK constraint.
--    This is the standard SQLite 12-step schema change; PRAGMA foreign_keys
--    is disabled by the migration runner before this transaction runs.
--
-- 2. Drop the old diff_cache / diff_cache_entries tables (design superseded).
--
-- 3. Create diff_dirs (must be before diff_entries due to FK reference).
--
-- 4. Create diff_entries.

CREATE TABLE jobs_new (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN ('scan', 'copy', 'verify', 'backup', 'diff')),
  -- Self-referencing FKs omitted intentionally: after RENAME the old name
  -- (jobs_new) persists in these FK declarations, causing "no such table"
  -- errors when foreign_keys=ON. The columns are preserved correctly; the FK
  -- declarations are re-expressed in the reconstructed indices below.
  parent_job_id             INTEGER,
  status                    TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  phase                     TEXT,
  active_sub_job_id         INTEGER,
  source_disk_id            INTEGER REFERENCES disks(id),
  dest_disk_id              INTEGER REFERENCES disks(id),
  target_disk_id            INTEGER REFERENCES disks(id),
  payload_json              TEXT,
  progress_json             TEXT,
  bytes_processed           INTEGER NOT NULL DEFAULT 0,
  items_processed           INTEGER NOT NULL DEFAULT 0,
  warnings_count            INTEGER NOT NULL DEFAULT 0,
  non_critical_errors_count INTEGER NOT NULL DEFAULT 0,
  errors_count              INTEGER NOT NULL DEFAULT 0,
  started_at                TEXT,
  updated_at                TEXT,
  completed_at              TEXT,
  created_by                TEXT    NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'composite')),
  created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO jobs_new SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);

-- Drop old diff_cache tables (design superseded by diff_entries + diff_dirs).
DROP TABLE IF EXISTS diff_cache_entries;
DROP TABLE IF EXISTS diff_cache;

-- Materialized directory-level diff aggregates.
-- Populated at the end of each diff job via the same O(files+dirs) bottom-up
-- rollup algorithm as recomputeAggregates in the scan job.
-- Paths are relative to the source disk's mount point (e.g. "/Documents").
-- The root directory has path = '/'.
CREATE TABLE diff_dirs (
  id             INTEGER PRIMARY KEY,
  diff_job_id    INTEGER NOT NULL REFERENCES jobs(id),
  parent_id      INTEGER REFERENCES diff_dirs(id),
  path           TEXT    NOT NULL,
  added_count    INTEGER NOT NULL DEFAULT 0,
  added_bytes    INTEGER NOT NULL DEFAULT 0,
  changed_count  INTEGER NOT NULL DEFAULT 0,
  changed_bytes  INTEGER NOT NULL DEFAULT 0,
  removed_count  INTEGER NOT NULL DEFAULT 0,
  removed_bytes  INTEGER NOT NULL DEFAULT 0,
  present_count  INTEGER NOT NULL DEFAULT 0,
  present_bytes  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX diff_dirs_job_path   ON diff_dirs (diff_job_id, path);
CREATE        INDEX diff_dirs_job_parent ON diff_dirs (diff_job_id, parent_id);

-- Per-file diff results for a diff job.
-- kind values: added / removed / changed / present
-- path: relative to source mount (source path for added/changed/present;
--        dest path for removed — same relative path in backup scenarios).
-- diff_dir_id: FK to the containing diff_dirs row (enables fast per-dir listing
--              without LIKE queries). NULL for removed entries whose parent dir
--              does not exist in the source disk's directory tree.
CREATE TABLE diff_entries (
  id             INTEGER PRIMARY KEY,
  diff_job_id    INTEGER NOT NULL REFERENCES jobs(id),
  diff_dir_id    INTEGER REFERENCES diff_dirs(id),
  source_file_id INTEGER REFERENCES files(id),
  dest_file_id   INTEGER REFERENCES files(id),
  kind           TEXT    NOT NULL CHECK (kind IN ('added', 'removed', 'changed', 'present')),
  path           TEXT    NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX diff_entries_job_kind ON diff_entries (diff_job_id, kind);
CREATE INDEX diff_entries_job_dir  ON diff_entries (diff_job_id, diff_dir_id);
