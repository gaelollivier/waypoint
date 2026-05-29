-- Media comparison batches: a reviewer (user) walks through pairs of media
-- files and tags each pair as `same`, `different`, or `unsure`. Verdicts feed
-- back into the agent so it knows which "plausible duplicate" signals (size
-- band, basename collision, etc.) are safe enough to act on later.
--
-- Two tables: a batch parent and an ordered list of pair members.
-- Cross-disk pairs are allowed; the streaming endpoint enforces that both
-- sides resolve under a registered disk mount.

CREATE TABLE comparison_batches (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  rationale   TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE comparison_members (
  id                 INTEGER PRIMARY KEY,
  batch_id           INTEGER NOT NULL REFERENCES comparison_batches(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  left_path          TEXT    NOT NULL,
  left_size_bytes    INTEGER,
  left_content_hash  TEXT,
  right_path         TEXT    NOT NULL,
  right_size_bytes   INTEGER,
  right_content_hash TEXT,
  note               TEXT    NOT NULL DEFAULT '',
  verdict            TEXT             CHECK (verdict IN ('same', 'different', 'unsure')),
  verdict_note       TEXT    NOT NULL DEFAULT '',
  verdicted_at       TEXT
);

-- Listing pages always paginate within a batch in `position` order; verdict
-- updates go through (id), which is the primary key.
CREATE INDEX comparison_members_batch_position
  ON comparison_members (batch_id, position);
