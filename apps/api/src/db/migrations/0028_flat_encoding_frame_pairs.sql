-- Flatten encoding frame comparisons.
--
-- New encoding frame comparison members represent exactly one sampled A/B
-- frame pair. The variant FKs still power rankings; these frame FKs let the
-- compare UI render only the chosen JPEGs instead of nesting multiple frames
-- inside one verdict row.

ALTER TABLE comparison_members
  ADD COLUMN left_frame_id INTEGER REFERENCES encoding_frames(id);

ALTER TABLE comparison_members
  ADD COLUMN right_frame_id INTEGER REFERENCES encoding_frames(id);

CREATE INDEX comparison_members_left_frame
  ON comparison_members (left_frame_id)
  WHERE left_frame_id IS NOT NULL;

CREATE INDEX comparison_members_right_frame
  ON comparison_members (right_frame_id)
  WHERE right_frame_id IS NOT NULL;
