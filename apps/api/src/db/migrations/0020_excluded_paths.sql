-- Per-disk exclusion list for duplicate detection ONLY.
--
-- Some disks contain self-contained archives that intentionally re-include
-- the same support files inside every sub-folder. Those show up as duplicate
-- groups on every detection run and the user has to dismiss them manually.
-- This table lets the user mark a directory (or a single file path) as
-- "ignore for duplicate-detection purposes" — both at the GROUP BY stage
-- (so no group forms purely from excluded files) and at the per-group
-- member listing (so an excluded copy never appears as a duplicate-group
-- file even when it would otherwise match a non-excluded sibling).
--
-- The exclusion is NOT applied to scan, diff, or copy. Scans still index
-- everything; diffs still see every file. Only the duplicate-detection
-- view of duplicate-ness is affected.

CREATE TABLE excluded_paths (
  id          INTEGER PRIMARY KEY,
  disk_id     INTEGER NOT NULL REFERENCES disks(id) ON DELETE CASCADE,
  path        TEXT    NOT NULL,                       -- absolute path; matches f.path OR f.path LIKE path || '/%'
  reason      TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One exclusion per (disk, path). Adding the same path twice is a no-op
-- candidate at the router layer; the unique index makes it a constraint
-- failure if we missed it.
CREATE UNIQUE INDEX excluded_paths_disk_path
  ON excluded_paths (disk_id, path);
