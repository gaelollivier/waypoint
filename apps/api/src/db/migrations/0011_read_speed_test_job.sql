-- Add read_speed_test to jobs.type for disk read benchmarking.

CREATE TABLE jobs_v11 (
  id                        INTEGER PRIMARY KEY,
  type                      TEXT    NOT NULL CHECK (type IN (
                                'scan', 'copy', 'verify', 'backup', 'diff',
                                'duplicate_detection', 'write_speed_test',
                                'read_speed_test'
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

INSERT INTO jobs_v11 SELECT * FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v11 RENAME TO jobs;

CREATE INDEX jobs_type_status  ON jobs (type, status);
CREATE INDEX jobs_target_disk  ON jobs (target_disk_id, type, completed_at DESC);
CREATE INDEX jobs_source_disk  ON jobs (source_disk_id, type, completed_at DESC);
CREATE INDEX jobs_dest_disk    ON jobs (dest_disk_id, type, completed_at DESC);
CREATE INDEX jobs_parent       ON jobs (parent_job_id);
