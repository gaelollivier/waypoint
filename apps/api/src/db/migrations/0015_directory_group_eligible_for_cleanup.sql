-- Marks a directory duplicate group as eligible for cleanup.
--
-- A group is eligible iff every file under every member directory has a
-- non-null full_hash recorded in the selected scan. This is the precondition
-- the per-file cleanup gateway needs to construct its full-hash proof for
-- every (keep, delete) file pair. Computed once at duplicate-detection time
-- so the UI can disable the delete affordance without an extra round-trip.

ALTER TABLE duplicate_directory_groups
  ADD COLUMN is_eligible_for_cleanup INTEGER NOT NULL DEFAULT 0;
