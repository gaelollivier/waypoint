-- Drop the `role` column from disks. The intent ("don't copy onto a source disk")
-- is better served by data-driven safeguards at copy time:
--   - free-space check at the destination before starting,
--   - per-file existence check (additive-only writes, never overwrite — see decisions.md).
--
-- SQLite supports DROP COLUMN since 3.35; bun:sqlite ships a recent enough version.

ALTER TABLE disks DROP COLUMN role;
