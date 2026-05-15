-- M10: Fix stale self-referencing FK on directories.parent_id
--
-- Migration 0009 created directories_v9 with parent_id REFERENCES
-- directories_v9(id). After ALTER TABLE RENAME, the FK target was left as
-- "directories_v9" which no longer exists — causing INSERT failures.
-- Recreate the table with the FK omitted (same pattern as 0004 for jobs).

CREATE TABLE directories_v10 (
  id                    INTEGER PRIMARY KEY,
  disk_id               INTEGER NOT NULL REFERENCES disks(id),
  scan_id               INTEGER NOT NULL REFERENCES jobs(id),
  parent_id             INTEGER,  -- self-ref FK omitted (SQLite rename bug)
  name                  TEXT    NOT NULL,
  path                  TEXT    NOT NULL,
  total_size_bytes      INTEGER NOT NULL DEFAULT 0,
  file_count            INTEGER NOT NULL DEFAULT 0,
  direct_file_count     INTEGER NOT NULL DEFAULT 0,
  aggregates_computed_at TEXT
);

INSERT INTO directories_v10
  SELECT * FROM directories;

DROP TABLE directories;
ALTER TABLE directories_v10 RENAME TO directories;

CREATE UNIQUE INDEX directories_scan_path   ON directories (scan_id, path);
CREATE        INDEX directories_scan_parent ON directories (scan_id, parent_id);
