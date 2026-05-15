-- Add content_hash to directories for folder-level duplicate detection.
-- content_hash is a BLAKE3 hash computed from all descendant files'
-- (relative_path, sampled_hash) pairs, enabling identical directory detection.

ALTER TABLE directories ADD COLUMN content_hash TEXT;

-- Directory-level duplicate groups (parallel to duplicate_groups for files)
CREATE TABLE duplicate_directory_groups (
  id               INTEGER PRIMARY KEY,
  duplicate_job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content_hash     TEXT    NOT NULL,
  directory_count  INTEGER NOT NULL,
  total_size_bytes INTEGER NOT NULL,
  wasted_bytes     INTEGER NOT NULL
);

CREATE INDEX duplicate_directory_groups_job
  ON duplicate_directory_groups (duplicate_job_id);

CREATE INDEX duplicate_directory_groups_job_wasted
  ON duplicate_directory_groups (duplicate_job_id, wasted_bytes DESC);

-- Members of each directory duplicate group
CREATE TABLE duplicate_directory_group_members (
  id           INTEGER PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES duplicate_directory_groups(id) ON DELETE CASCADE,
  directory_id INTEGER NOT NULL,
  path         TEXT    NOT NULL
);

CREATE INDEX duplicate_directory_group_members_group
  ON duplicate_directory_group_members (group_id);
