-- Duplicate groups now record which persisted hash evidence they were built from.
-- Existing rows predate full-hash-aware duplicate detection, so they are sampled-only.
ALTER TABLE duplicate_groups ADD COLUMN hash_kind TEXT NOT NULL DEFAULT 'sampled'
  CHECK (hash_kind IN ('full', 'sampled'));
ALTER TABLE duplicate_groups ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
UPDATE duplicate_groups SET content_hash = sampled_hash WHERE content_hash = '';
CREATE INDEX duplicate_groups_job_hash_kind ON duplicate_groups (duplicate_job_id, hash_kind);
