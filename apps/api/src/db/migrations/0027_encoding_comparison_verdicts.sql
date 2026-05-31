-- Encoding frame comparisons need preference-style verdicts. The original
-- comparison UI only needed duplicate verdicts (`same`, `different`,
-- `unsure`). Keep those values for dedup batches and add `prefer_left`,
-- `prefer_right`, and `tie` for blinded encoder comparisons.

CREATE TABLE comparison_members_v27 (
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
  verdict            TEXT             CHECK (verdict IN (
                        'same', 'different', 'unsure',
                        'prefer_left', 'prefer_right', 'tie'
                      )),
  verdict_note       TEXT    NOT NULL DEFAULT '',
  verdicted_at       TEXT,
  left_variant_id    INTEGER REFERENCES encoding_variants(id),
  right_variant_id   INTEGER REFERENCES encoding_variants(id)
);

INSERT INTO comparison_members_v27 (
  id, batch_id, position,
  left_path, left_size_bytes, left_content_hash,
  right_path, right_size_bytes, right_content_hash,
  note, verdict, verdict_note, verdicted_at,
  left_variant_id, right_variant_id
)
SELECT
  id, batch_id, position,
  left_path, left_size_bytes, left_content_hash,
  right_path, right_size_bytes, right_content_hash,
  note, verdict, verdict_note, verdicted_at,
  left_variant_id, right_variant_id
FROM comparison_members;

DROP TABLE comparison_members;
ALTER TABLE comparison_members_v27 RENAME TO comparison_members;

CREATE INDEX comparison_members_batch_position
  ON comparison_members (batch_id, position);

CREATE INDEX comparison_members_left_variant
  ON comparison_members (left_variant_id)
  WHERE left_variant_id IS NOT NULL;

CREATE INDEX comparison_members_right_variant
  ON comparison_members (right_variant_id)
  WHERE right_variant_id IS NOT NULL;
