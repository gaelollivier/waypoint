-- M10: Duplicate detection job tables
--
-- Adds 'duplicate_detection' to the jobs.type CHECK constraint (same 12-step
-- SQLite rename pattern as 0004; self-referencing FKs on parent_job_id and
-- active_sub_job_id are intentionally omitted to avoid the post-rename
-- table-name staleness bug documented in 0004).
--
-- Also creates:
--   duplicate_groups      — one row per hash that appears >1 time on a disk
--   duplicate_group_files — one row per file member of a group

CREATE TABLE jobs_v5 (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN (
                                'scan', 'copy', 'verify', 'backup', 'diff', 'duplicate_detection'
                            )),
  parent_job_id             INTEGER,                        -- self-ref FK omitted (see 0004)
  status                    TEXT    NOT NULL CHECK (status IN (
                                'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'
                            )),
  phase                     TEXT,
  active_sub_job_id         INTEGER,                        -- self-ref FK omitted (see 0004)
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

INSERT INTO jobs_v5 SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v5 RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);

-- One row per unique sampled_hash that appears more than once within a disk scan.
CREATE TABLE duplicate_groups (
  id               INTEGER PRIMARY KEY,
  duplicate_job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sampled_hash     TEXT    NOT NULL,
  file_count       INTEGER NOT NULL,
  size_bytes       INTEGER NOT NULL,   -- per-file size (taken from first GROUP BY match)
  wasted_bytes     INTEGER NOT NULL    -- size_bytes * (file_count - 1)
);

CREATE INDEX duplicate_groups_job        ON duplicate_groups (duplicate_job_id);
CREATE INDEX duplicate_groups_job_wasted ON duplicate_groups (duplicate_job_id, wasted_bytes DESC);

-- Individual file membership within a duplicate group.
CREATE TABLE duplicate_group_files (
  id       INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  file_id  INTEGER NOT NULL REFERENCES files(id),
  path     TEXT    NOT NULL
);

CREATE INDEX duplicate_group_files_group ON duplicate_group_files (group_id);
