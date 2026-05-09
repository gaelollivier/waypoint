-- Fix broken self-referencing FK declarations in the `jobs` table.
--
-- Background: migration 0003 used the SQLite 12-step schema change to add 'diff'
-- to the type CHECK constraint. The intermediate table was named `jobs_new`.
-- An earlier version of that migration left `REFERENCES jobs_new(id)` on the
-- `parent_job_id` and `active_sub_job_id` columns. After `ALTER TABLE jobs_new
-- RENAME TO jobs`, SQLite did not update those self-referencing FK declarations
-- in the stored DDL, leaving them pointing to the now-nonexistent `jobs_new`.
-- This causes `no such table: main.jobs_new` on any PREPARE while foreign_keys=ON.
--
-- Fix: redo the 12-step rename with the correct DDL (self-referencing FKs omitted,
-- same as 0003 intended). foreign_keys is disabled by the migration runner before
-- this transaction runs.

CREATE TABLE jobs_fix (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN ('scan', 'copy', 'verify', 'backup', 'diff')),
  parent_job_id             INTEGER,                        -- self-ref FK omitted: SQLite persists old table name after RENAME
  status                    TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  phase                     TEXT,
  active_sub_job_id         INTEGER,                        -- self-ref FK omitted: same reason
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

INSERT INTO jobs_fix SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_fix RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);
