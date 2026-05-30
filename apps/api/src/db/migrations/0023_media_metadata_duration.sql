-- Add duration in seconds (real, nullable) to media_metadata. Videos benefit
-- most: combining captured_at_unix with duration gives a near-unique join
-- key, even when Google has stripped Make/Model from re-encoded uploads.
-- Images leave the column NULL.

ALTER TABLE media_metadata ADD COLUMN duration_seconds REAL;
