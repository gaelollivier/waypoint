-- Persistent cleanup state, keyed to the scan snapshot the deletion was made
-- against. Splitting these out of duplicate_group_files lets the UI keep the
-- "already deleted" markers across re-runs of duplicate detection on the
-- same scan, and lets directory-cleanup write the same record shape as
-- file-cleanup. The state becomes obsolete naturally on a new scan because
-- file_id / directory_id are scan-snapshot keys.
--
-- Why a separate table per kind (instead of one with a discriminator):
-- - file_id and directory_id have distinct FK targets; collapsing them would
--   force a nullable column pair with no FK enforcement on either side
-- - the file-level UI only needs deleted_files; the directory-level UI only
--   needs deleted_directories; querying one without the other is cheaper

CREATE TABLE deleted_files (
  file_id    INTEGER PRIMARY KEY REFERENCES files(id),
  scan_id    INTEGER NOT NULL    REFERENCES jobs(id),
  deleted_at TEXT    NOT NULL
);

CREATE INDEX deleted_files_scan ON deleted_files (scan_id);

CREATE TABLE deleted_directories (
  directory_id INTEGER PRIMARY KEY REFERENCES directories(id),
  scan_id      INTEGER NOT NULL    REFERENCES jobs(id),
  deleted_at   TEXT    NOT NULL
);

CREATE INDEX deleted_directories_scan ON deleted_directories (scan_id);

-- Migrate existing duplicate_group_files.deleted_at into deleted_files.
-- Each duplicate_group_files row is tied to a duplicate_groups → jobs row
-- whose payload_json.scanId is the scan we want to attribute the deletion to.
-- Drop NULL rows; only previously-deleted files end up in the new table.
INSERT INTO deleted_files (file_id, scan_id, deleted_at)
  SELECT dgf.file_id, f.scan_id, dgf.deleted_at
  FROM duplicate_group_files dgf
  JOIN files f ON f.id = dgf.file_id
  WHERE dgf.deleted_at IS NOT NULL;

-- Recreate duplicate_group_files without the deleted_at column.
CREATE TABLE duplicate_group_files_v17 (
  id       INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  file_id  INTEGER NOT NULL REFERENCES files(id),
  path     TEXT    NOT NULL
);

INSERT INTO duplicate_group_files_v17 (id, group_id, file_id, path)
  SELECT id, group_id, file_id, path FROM duplicate_group_files;

DROP TABLE duplicate_group_files;
ALTER TABLE duplicate_group_files_v17 RENAME TO duplicate_group_files;

CREATE INDEX duplicate_group_files_group ON duplicate_group_files (group_id);
