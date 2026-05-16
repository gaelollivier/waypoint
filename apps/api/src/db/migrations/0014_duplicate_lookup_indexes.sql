-- Duplicate detection performs two hot lookups over files scoped to one scan:
--   full-backed groups:    scan_id + full_hash + size_bytes
--   sampled-only groups:   scan_id + sampled_hash + size_bytes, only when full_hash IS NULL
-- Keep these as partial indexes so the duplicate job can use simple, sargable
-- predicates instead of expression filters over the whole scan snapshot.
CREATE INDEX files_scan_full_hash_size
  ON files (scan_id, full_hash, size_bytes)
  WHERE full_hash IS NOT NULL;

CREATE INDEX files_scan_sampled_only_hash_size
  ON files (scan_id, sampled_hash, size_bytes)
  WHERE full_hash IS NULL;
