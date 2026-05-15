-- M9: Scan snapshots — append-only files/directories with scan_id
--
-- Each scan now creates fresh rows instead of upserting in place.
-- `scan_id` replaces `last_scan_id` as the primary scope key.
-- Consumers query by scan_id (one scan = one disk snapshot).
--
-- Uses the standard 12-step SQLite table recreation pattern (same as 0004/0005).

-- ── directories ─────────────────────────────────────────────────────────────

CREATE TABLE directories_v9 (
  id                    INTEGER PRIMARY KEY,
  disk_id               INTEGER NOT NULL REFERENCES disks(id),
  scan_id               INTEGER NOT NULL REFERENCES jobs(id),
  parent_id             INTEGER,  -- self-ref FK omitted (same SQLite rename bug as 0004)
  name                  TEXT    NOT NULL,
  path                  TEXT    NOT NULL,
  total_size_bytes      INTEGER NOT NULL DEFAULT 0,
  file_count            INTEGER NOT NULL DEFAULT 0,
  direct_file_count     INTEGER NOT NULL DEFAULT 0,
  aggregates_computed_at TEXT
);

INSERT INTO directories_v9 (id, disk_id, scan_id, parent_id, name, path, total_size_bytes, file_count, direct_file_count, aggregates_computed_at)
  SELECT id, disk_id, COALESCE(last_scan_id, (SELECT last_scan_job_id FROM disks WHERE disks.id = directories.disk_id)), parent_id, name, path, total_size_bytes, file_count, direct_file_count, aggregates_computed_at
  FROM directories;

DROP TABLE directories;
ALTER TABLE directories_v9 RENAME TO directories;

CREATE UNIQUE INDEX directories_scan_path   ON directories (scan_id, path);
CREATE        INDEX directories_scan_parent ON directories (scan_id, parent_id);

-- ── files ───────────────────────────────────────────────────────────────────

CREATE TABLE files_v9 (
  id               INTEGER PRIMARY KEY,
  disk_id          INTEGER NOT NULL REFERENCES disks(id),
  scan_id          INTEGER NOT NULL REFERENCES jobs(id),
  directory_id     INTEGER NOT NULL REFERENCES directories(id),
  name             TEXT    NOT NULL,
  path             TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL,
  mtime            TEXT    NOT NULL,
  sampled_hash     TEXT,
  full_hash        TEXT,
  hash_algo_version INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT
);

INSERT INTO files_v9 (id, disk_id, scan_id, directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version, last_verified_at)
  SELECT id, disk_id, COALESCE(last_scan_id, (SELECT last_scan_job_id FROM disks WHERE disks.id = files.disk_id)), directory_id, name, path, size_bytes, mtime, sampled_hash, full_hash, hash_algo_version, last_verified_at
  FROM files;

DROP TABLE files;
ALTER TABLE files_v9 RENAME TO files;

CREATE UNIQUE INDEX files_scan_path ON files (scan_id, path);
CREATE        INDEX files_scan_dir  ON files (scan_id, directory_id);
CREATE        INDEX files_scan_hash ON files (scan_id, sampled_hash);
