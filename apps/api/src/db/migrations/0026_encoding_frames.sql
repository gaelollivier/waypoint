-- Frame extraction for encoding comparison.
--
-- For each (sample, variant) the encoding comparison UI needs a small set of
-- evenly-spaced JPEG frames so it can show a side-by-side grid without
-- having to seek into the source/variant container at render time. Source
-- frames are extracted once per sample (independent of variant count) so
-- comparing two variants of the same sample against the source doesn't
-- duplicate the source extraction.
--
-- A single `encoding_frames` table covers both flavours. Exactly one of
-- `sample_id` (source frames) or `variant_id` (encoded frames) is set on
-- any given row, enforced by CHECK. The two query patterns the UI needs
-- ("all source frames for sample X" and "all frames for variant Y") are
-- both single-FK lookups via the partial unique indexes below.
--
-- `position` is the 0-based frame index; `at_seconds` is the timestamp
-- inside the clip window (already includes any clip_start offset on the
-- sample). Re-running the extract job for a row whose output_path is NULL
-- is the supported way to recover after a scratch cleanup wiped the file.

CREATE TABLE encoding_frames (
  id            INTEGER PRIMARY KEY,
  sample_id     INTEGER REFERENCES encoding_samples(id)  ON DELETE CASCADE,
  variant_id    INTEGER REFERENCES encoding_variants(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  at_seconds    REAL    NOT NULL,
  output_path   TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed')),
  error_detail  TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  CHECK (
    (sample_id IS NOT NULL AND variant_id IS NULL)
    OR
    (sample_id IS NULL AND variant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX encoding_frames_sample_position
  ON encoding_frames (sample_id, position)
  WHERE sample_id IS NOT NULL;

CREATE UNIQUE INDEX encoding_frames_variant_position
  ON encoding_frames (variant_id, position)
  WHERE variant_id IS NOT NULL;

CREATE INDEX encoding_frames_status
  ON encoding_frames (status);

-- Extend jobs.type with encoding_frame_extract. SQLite can't alter a CHECK
-- constraint in place so we rebuild the table; preserve every existing row
-- and recreate the indexes the rest of the codebase depends on.

CREATE TABLE jobs_v26 (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN (
                                'scan', 'copy', 'verify', 'backup', 'diff',
                                'duplicate_detection', 'directory_duplicate_cleanup',
                                'write_speed_test', 'read_speed_test',
                                'media_metadata_extraction',
                                'encoding_sample_run',
                                'encoding_frame_extract'
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

INSERT INTO jobs_v26 SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v26 RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);
