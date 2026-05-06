-- Waypoint v1 initial schema

-- Key-value config / schema metadata
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Physical disks (SSD source + HDD destinations)
CREATE TABLE disks (
  id                  INTEGER PRIMARY KEY,
  disk_uuid           TEXT    NOT NULL UNIQUE,
  label               TEXT,
  kind                TEXT    NOT NULL CHECK (kind IN ('ssd', 'hdd')),
  role                TEXT    NOT NULL CHECK (role IN ('source', 'destination')),
  capacity_bytes      INTEGER,
  free_bytes          INTEGER,
  mount_path          TEXT,
  is_connected        INTEGER NOT NULL DEFAULT 0,  -- boolean
  last_seen_at        TEXT,
  last_scan_job_id    INTEGER REFERENCES jobs(id),
  last_scan_at        TEXT,
  last_backup_job_id  INTEGER REFERENCES jobs(id),
  last_backup_at      TEXT,
  last_verify_job_id  INTEGER REFERENCES jobs(id),
  last_verify_at      TEXT
);

-- Every directory across every disk, with materialized size aggregates
CREATE TABLE directories (
  id                    INTEGER PRIMARY KEY,
  disk_id               INTEGER NOT NULL REFERENCES disks(id),
  parent_id             INTEGER REFERENCES directories(id),
  name                  TEXT    NOT NULL,
  path                  TEXT    NOT NULL,
  total_size_bytes      INTEGER NOT NULL DEFAULT 0,
  file_count            INTEGER NOT NULL DEFAULT 0,
  direct_file_count     INTEGER NOT NULL DEFAULT 0,
  last_scan_id          INTEGER REFERENCES jobs(id),
  aggregates_computed_at TEXT
);

CREATE UNIQUE INDEX directories_disk_path ON directories (disk_id, path);
CREATE        INDEX directories_disk_parent ON directories (disk_id, parent_id);

-- Every file across every disk (current state, no history)
CREATE TABLE files (
  id               INTEGER PRIMARY KEY,
  disk_id          INTEGER NOT NULL REFERENCES disks(id),
  directory_id     INTEGER NOT NULL REFERENCES directories(id),
  name             TEXT    NOT NULL,
  path             TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL,
  mtime            TEXT    NOT NULL,
  sampled_hash     TEXT,
  full_hash        TEXT,
  hash_algo_version INTEGER NOT NULL DEFAULT 1,
  last_scan_id     INTEGER REFERENCES jobs(id),
  last_verified_at TEXT
);

CREATE UNIQUE INDEX files_disk_dir_name ON files (disk_id, directory_id, name);
CREATE UNIQUE INDEX files_disk_path     ON files (disk_id, path);
CREATE        INDEX files_sampled_hash  ON files (sampled_hash);
CREATE        INDEX files_disk_scan     ON files (disk_id, last_scan_id);

-- Jobs: primitive (scan / copy / verify) and composite (backup)
CREATE TABLE jobs (
  id                      INTEGER PRIMARY KEY,
  type                    TEXT    NOT NULL CHECK (type IN ('scan', 'copy', 'verify', 'backup')),
  parent_job_id           INTEGER REFERENCES jobs(id),
  status                  TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  phase                   TEXT,   -- composite only: scanning_source / scanning_dest / diffing / copying / done
  active_sub_job_id       INTEGER REFERENCES jobs(id),
  source_disk_id          INTEGER REFERENCES disks(id),
  dest_disk_id            INTEGER REFERENCES disks(id),
  target_disk_id          INTEGER REFERENCES disks(id),
  payload_json            TEXT,
  progress_json           TEXT,
  bytes_processed         INTEGER NOT NULL DEFAULT 0,
  items_processed         INTEGER NOT NULL DEFAULT 0,
  warnings_count          INTEGER NOT NULL DEFAULT 0,
  non_critical_errors_count INTEGER NOT NULL DEFAULT 0,
  errors_count            INTEGER NOT NULL DEFAULT 0,
  started_at              TEXT,
  updated_at              TEXT,
  completed_at            TEXT,
  created_by              TEXT    NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'composite')),
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX jobs_type_status     ON jobs (type, status);
CREATE INDEX jobs_target_disk     ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk     ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk       ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent          ON jobs (parent_job_id);

-- Persisted walk queue for resumable scanning
CREATE TABLE scan_walk_queue (
  id                  INTEGER PRIMARY KEY,
  scan_job_id         INTEGER NOT NULL REFERENCES jobs(id),
  disk_id             INTEGER NOT NULL REFERENCES disks(id),
  path                TEXT    NOT NULL,
  parent_directory_id INTEGER REFERENCES directories(id),
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'error')),
  enqueued_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at          TEXT,
  completed_at        TEXT,
  error_detail        TEXT
);

CREATE INDEX scan_walk_queue_job_status ON scan_walk_queue (scan_job_id, status);

-- Per-file copy state for resumable copy jobs
CREATE TABLE copy_items (
  id              INTEGER PRIMARY KEY,
  copy_job_id     INTEGER NOT NULL REFERENCES jobs(id),
  source_file_id  INTEGER NOT NULL REFERENCES files(id),
  dest_disk_id    INTEGER NOT NULL REFERENCES disks(id),
  dest_path       TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'error_hash_mismatch', 'error_io', 'skipped_already_present')),
  bytes_copied    INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  completed_at    TEXT,
  error_detail    TEXT,
  temp_filename   TEXT
);

CREATE INDEX copy_items_job_status ON copy_items (copy_job_id, status);

-- Per-file verify state
CREATE TABLE verify_items (
  id              INTEGER PRIMARY KEY,
  verify_job_id   INTEGER NOT NULL REFERENCES jobs(id),
  file_id         INTEGER NOT NULL REFERENCES files(id),
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'verified', 'mismatch', 'read_error')),
  recomputed_hash TEXT,
  completed_at    TEXT,
  error_detail    TEXT
);

-- Per-job structured event log
CREATE TABLE job_events (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  timestamp    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  level        TEXT    NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  category     TEXT    NOT NULL,  -- excluded / error / phase_change / progress_milestone / etc.
  message      TEXT    NOT NULL,
  payload_json TEXT
);

CREATE INDEX job_events_job_time     ON job_events (job_id, timestamp);
CREATE INDEX job_events_job_category ON job_events (job_id, category);

-- Cached diff results between two scans
CREATE TABLE diff_cache (
  id             INTEGER PRIMARY KEY,
  source_disk_id INTEGER NOT NULL REFERENCES disks(id),
  source_scan_id INTEGER NOT NULL REFERENCES jobs(id),
  dest_disk_id   INTEGER NOT NULL REFERENCES disks(id),
  dest_scan_id   INTEGER NOT NULL REFERENCES jobs(id),
  computed_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status         TEXT    NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'superseded'))
);

CREATE TABLE diff_cache_entries (
  id             INTEGER PRIMARY KEY,
  diff_cache_id  INTEGER NOT NULL REFERENCES diff_cache(id),
  source_file_id INTEGER REFERENCES files(id),
  dest_file_id   INTEGER REFERENCES files(id),
  kind           TEXT    NOT NULL CHECK (kind IN ('only_on_source', 'only_on_dest', 'differing_content', 'present_both')),
  path           TEXT    NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX diff_cache_entries_cache_kind ON diff_cache_entries (diff_cache_id, kind);

-- Per-disk glob patterns applied at copy time (not scan time)
CREATE TABLE disk_excludes (
  id         INTEGER PRIMARY KEY,
  disk_id    INTEGER NOT NULL REFERENCES disks(id),
  pattern    TEXT    NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1
);

-- In-memory write-lock state mirrored to DB
CREATE TABLE disk_locks (
  disk_id        INTEGER PRIMARY KEY REFERENCES disks(id),
  held_by_job_id INTEGER NOT NULL REFERENCES jobs(id),
  state          TEXT    NOT NULL CHECK (state IN ('active', 'paused')),
  acquired_at    TEXT    NOT NULL,
  paused_at      TEXT
);

-- Files moved to .waypoint-quarantine/ (tool never deletes, only moves)
CREATE TABLE quarantine_items (
  id              INTEGER PRIMARY KEY,
  disk_id         INTEGER NOT NULL REFERENCES disks(id),
  original_path   TEXT    NOT NULL,
  quarantine_path TEXT    NOT NULL,
  reason          TEXT    NOT NULL DEFAULT 'orphan_temp',
  source_job_id   INTEGER REFERENCES jobs(id),
  moved_by_job_id INTEGER REFERENCES jobs(id),
  moved_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  size_bytes      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX quarantine_items_disk_moved ON quarantine_items (disk_id, moved_at DESC);
