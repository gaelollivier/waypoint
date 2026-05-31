-- Encoding comparison MVP.
--
-- The user picks a small set of representative source videos and an encoder
-- matrix (codec × preset × CRF). The tool encodes each (sample, variant)
-- combination to a scratch directory, extracts a handful of evenly-spaced
-- frames from the source + every variant, and then surfaces side-by-side
-- comparisons in the existing /compare UI. The verdicts feed a
-- Bradley-Terry fit so we can rank variants per sample and pick the
-- production sweet spot.
--
-- Three tables here:
--
-- * `encoding_sample_sets` — the user's per-run experiment. Holds the
--   scratch root so we know where to clean up.
-- * `encoding_samples` — one row per source clip. Carries the optional
--   clip window (start + duration) so we don't always have to encode the
--   whole source.
-- * `encoding_variants` — one row per (sample × encoder × preset × CRF)
--   combination. Status / output / wall-clock columns are populated by
--   the encoder job. Frame paths and verdicts come later.

CREATE TABLE encoding_sample_sets (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  notes         TEXT    NOT NULL DEFAULT '',
  scratch_root  TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'encoding', 'ready', 'archived')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE encoding_samples (
  id                     INTEGER PRIMARY KEY,
  set_id                 INTEGER NOT NULL REFERENCES encoding_sample_sets(id) ON DELETE CASCADE,
  position               INTEGER NOT NULL,
  source_disk_id         INTEGER NOT NULL REFERENCES disks(id),
  source_path            TEXT    NOT NULL,
  source_file_id         INTEGER REFERENCES files(id),
  clip_start_seconds     REAL,
  clip_duration_seconds  REAL,
  label                  TEXT    NOT NULL DEFAULT '',
  -- Cached at registration time so the comparison UI can render even if the
  -- source file later gets re-scanned with different metadata.
  source_size_bytes      INTEGER,
  source_duration_seconds REAL,
  source_make            TEXT,
  source_model           TEXT,
  source_captured_at_unix INTEGER
);

CREATE INDEX encoding_samples_set ON encoding_samples (set_id, position);

CREATE TABLE encoding_variants (
  id                  INTEGER PRIMARY KEY,
  sample_id           INTEGER NOT NULL REFERENCES encoding_samples(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL,
  codec               TEXT    NOT NULL,    -- 'hevc' | 'av1' | 'h264' | 'reference'
  encoder             TEXT    NOT NULL,    -- 'libx265' | 'hevc_videotoolbox' | 'libsvtav1' | 'libaom-av1' | 'copy'
  preset              TEXT,                -- 'medium' | 'slow' | '6' | etc.
  crf                 REAL,
  extra_args_json     TEXT,                -- JSON array of extra ffmpeg args
  label               TEXT    NOT NULL DEFAULT '',
  output_path         TEXT,
  output_size_bytes   INTEGER,
  encode_seconds      REAL,
  status              TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  error_detail        TEXT,
  started_at          TEXT,
  completed_at        TEXT
);

CREATE INDEX encoding_variants_sample ON encoding_variants (sample_id, position);
CREATE INDEX encoding_variants_status ON encoding_variants (status);

-- Extend comparison_batches with a `kind` so the existing dedup-pair UI can
-- coexist with the new encoding comparison flow. The default keeps existing
-- rows on `dedup`. Encoding batches carry a reference to the source sample.

CREATE TABLE comparison_batches_v25 (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  rationale   TEXT    NOT NULL DEFAULT '',
  kind        TEXT    NOT NULL DEFAULT 'dedup'
              CHECK (kind IN ('dedup', 'encoding_frames', 'encoding_video')),
  sample_id   INTEGER REFERENCES encoding_samples(id),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO comparison_batches_v25 (id, name, rationale, created_at)
  SELECT id, name, rationale, created_at FROM comparison_batches;

DROP TABLE comparison_batches;
ALTER TABLE comparison_batches_v25 RENAME TO comparison_batches;

CREATE INDEX comparison_batches_kind ON comparison_batches (kind);
CREATE INDEX comparison_batches_sample
  ON comparison_batches (sample_id)
  WHERE sample_id IS NOT NULL;

-- Encoding comparison members refer to two variants of the same sample. The
-- existing `left_path` / `right_path` text columns still carry a renderable
-- path so the UI can show the file, but the foreign keys let us resolve
-- everything else (codec, preset, output size, frame directory).

ALTER TABLE comparison_members ADD COLUMN left_variant_id  INTEGER REFERENCES encoding_variants(id);
ALTER TABLE comparison_members ADD COLUMN right_variant_id INTEGER REFERENCES encoding_variants(id);

CREATE INDEX comparison_members_left_variant
  ON comparison_members (left_variant_id)
  WHERE left_variant_id IS NOT NULL;
CREATE INDEX comparison_members_right_variant
  ON comparison_members (right_variant_id)
  WHERE right_variant_id IS NOT NULL;

-- The encoder job type. Drives one sample set end-to-end (all sample × variant
-- combos that aren't already `done`).

CREATE TABLE jobs_v25 (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN (
                                'scan', 'copy', 'verify', 'backup', 'diff',
                                'duplicate_detection', 'directory_duplicate_cleanup',
                                'write_speed_test', 'read_speed_test',
                                'media_metadata_extraction',
                                'encoding_sample_run'
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

INSERT INTO jobs_v25 SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v25 RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);
