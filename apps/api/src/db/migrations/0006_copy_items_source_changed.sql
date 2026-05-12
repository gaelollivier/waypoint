-- Add 'skipped_source_changed' to copy_items status CHECK constraint.
-- SQLite doesn't support ALTER CHECK — must recreate the table.

CREATE TABLE copy_items_new (
  id              INTEGER PRIMARY KEY,
  copy_job_id     INTEGER NOT NULL REFERENCES jobs(id),
  source_file_id  INTEGER NOT NULL REFERENCES files(id),
  dest_disk_id    INTEGER NOT NULL REFERENCES disks(id),
  dest_path       TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'in_progress', 'done',
    'error_hash_mismatch', 'error_io',
    'skipped_already_present', 'skipped_source_changed'
  )),
  bytes_copied    INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  completed_at    TEXT,
  error_detail    TEXT,
  temp_filename   TEXT
);

INSERT INTO copy_items_new SELECT * FROM copy_items;
DROP TABLE copy_items;
ALTER TABLE copy_items_new RENAME TO copy_items;

CREATE INDEX copy_items_job_status ON copy_items (copy_job_id, status);
