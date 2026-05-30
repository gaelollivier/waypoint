-- Media metadata extraction: per-file EXIF / QuickTime metadata, persisted
-- alongside scan-derived data. One row per file_id; deleting the file row
-- via the parent files table cascades the metadata row away.
--
-- The goal is to support cross-tree duplicate detection where bytes differ
-- (e.g. Google_Backup re-encodes vs Photos - Videos originals) by joining
-- on capture timestamp + camera, which survives re-encoding.

CREATE TABLE media_metadata (
  file_id              INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  -- ISO-8601 string in the timezone the EXIF tag is recorded in (typically
  -- the camera's local TZ, no offset). Null when no datetime tag is present.
  datetime_original    TEXT,
  -- Where the timestamp came from. Lets us prefer EXIF over file mtime
  -- when joining.
  datetime_source      TEXT    CHECK (datetime_source IN ('exif', 'quicktime', 'sidecar', 'mtime', 'none')),
  -- Camera vendor + model strings, normalised lowercase + trimmed. Null
  -- when not present.
  make                 TEXT,
  model                TEXT,
  -- Unix seconds for sortable joins. Mirrors datetime_original.
  captured_at_unix     INTEGER,
  -- Set when extraction succeeded but no datetime could be derived OR when
  -- extraction failed outright. Useful for retry-skip logic.
  extraction_error     TEXT,
  extracted_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Primary join index: same camera + same capture second = strong same-shot
-- signal across trees.
CREATE INDEX media_metadata_join
  ON media_metadata (captured_at_unix, make, model)
  WHERE captured_at_unix IS NOT NULL;

-- Add 'media_metadata_extraction' to the jobs.type CHECK constraint. SQLite
-- can't ALTER a CHECK, so rebuild the table following the 0011 pattern.

CREATE TABLE jobs_v22 (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN (
                                'scan', 'copy', 'verify', 'backup', 'diff',
                                'duplicate_detection', 'directory_duplicate_cleanup',
                                'write_speed_test', 'read_speed_test',
                                'media_metadata_extraction'
                            )),
  parent_job_id             INTEGER,
  status                    TEXT    NOT NULL CHECK (status IN (
                                'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'
                            )),
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

INSERT INTO jobs_v22 SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v22 RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);
