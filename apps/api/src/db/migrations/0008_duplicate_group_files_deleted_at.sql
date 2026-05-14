-- Track which duplicate files have been cleaned up, so the UI can show
-- progress without re-running the detection job.

ALTER TABLE duplicate_group_files ADD COLUMN deleted_at TEXT DEFAULT NULL;
