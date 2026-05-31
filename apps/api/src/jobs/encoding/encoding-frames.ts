import type { Database } from "bun:sqlite";

/**
 * Helpers for the frame-extraction job that don't need a JobRunner. Splitting
 * them out lets the tests cover the pre-creation + timestamp math without
 * having to spawn an ffmpeg subprocess.
 */

export interface SampleTiming {
  id: number;
  clip_start_seconds: number | null;
  clip_duration_seconds: number | null;
  source_duration_seconds: number | null;
}

export interface SampleSkippedReason {
  sampleId: number;
  reason: "no_duration";
}

export interface EnsureFramesResult {
  insertedSourceRows: number;
  insertedVariantRows: number;
  /**
   * Rows that already existed but had a different `at_seconds` and have been
   * corrected in place. Only rows that haven't been successfully extracted
   * (status != 'done') are touched, so a successful frame keeps its committed
   * timestamp even if the timestamp formula later changes.
   */
  retimedSourceRows: number;
  retimedVariantRows: number;
  samplesSkipped: SampleSkippedReason[];
}

/**
 * Returns the N timestamps (seconds) at which to extract frames for a given
 * sample. Returns null when the sample has no usable duration (no clip
 * window AND no cached source duration).
 *
 * Timestamps are placed at the center of N equal sub-intervals so frame 0
 * lands inside the first sub-window rather than on the very first frame
 * (which is often a black frame or a hard cut).
 *
 * `relative` switches which input the timestamps target:
 *   - false (default): absolute in the original source file, for ffmpeg
 *     seeking into the on-disk source video.
 *       t_i = clip_start + ((i + 0.5) / N) * duration
 *   - true: relative to the start of the encoded variant clip, which
 *     itself begins at second 0 because the encoder writes a trimmed
 *     output (-ss clip_start -i source -t duration).
 *       t_i = ((i + 0.5) / N) * duration
 *
 * Mixing these up makes the variant ffmpeg seek past EOF and emit "No
 * filtered frames for output stream" → exit code 234. The runtime in
 * `EncodingFrameExtractJobRunner` passes the stored `at_seconds` straight
 * to `-ss`, so the column convention is: source rows store absolute,
 * variant rows store relative.
 */
export function computeFrameTimestamps(
  sample: SampleTiming,
  count: number,
  relative = false
): number[] | null {
  const duration =
    sample.clip_duration_seconds ?? sample.source_duration_seconds ?? null;
  if (duration === null || duration <= 0) return null;
  const start = relative ? 0 : sample.clip_start_seconds ?? 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(start + ((i + 0.5) / count) * duration);
  }
  return out;
}

/**
 * Idempotently inserts the expected `encoding_frames` rows for the given
 * sample set:
 *   - N rows per sample for the source clip (`sample_id` set, `variant_id`
 *     NULL)
 *   - N rows per `status='done'` variant of each sample (`variant_id` set,
 *     `sample_id` NULL)
 *
 * Existing rows keep their per-frame status across re-runs. Rows that
 * haven't been successfully extracted (status != 'done') have their
 * `at_seconds` rewritten to match the current formula, so a code fix to the
 * timestamp math self-heals on the next extract-frames run without needing
 * a manual row wipe. Rows already at status='done' are never touched —
 * their JPEG was extracted at the persisted timestamp and changing it
 * would lie about what's on disk.
 *
 * Samples whose duration we can't determine are skipped and surfaced in
 * the returned `samplesSkipped` list so the caller can log them.
 */
export function ensureFrameRowsForSet(
  db: Database,
  setId: number,
  framesPerVariant: number
): EnsureFramesResult {
  const samples = db
    .prepare(
      `SELECT id, clip_start_seconds, clip_duration_seconds, source_duration_seconds
         FROM encoding_samples
        WHERE set_id = ?
        ORDER BY position`
    )
    .all(setId) as SampleTiming[];

  const insertFrame = db.prepare(
    `INSERT OR IGNORE INTO encoding_frames
       (sample_id, variant_id, position, at_seconds, status)
     VALUES (?, ?, ?, ?, 'pending')`
  );
  const retimeSource = db.prepare(
    `UPDATE encoding_frames
        SET at_seconds = ?
      WHERE sample_id = ?
        AND position = ?
        AND status != 'done'
        AND at_seconds != ?`
  );
  const retimeVariant = db.prepare(
    `UPDATE encoding_frames
        SET at_seconds = ?
      WHERE variant_id = ?
        AND position = ?
        AND status != 'done'
        AND at_seconds != ?`
  );

  const result: EnsureFramesResult = {
    insertedSourceRows: 0,
    insertedVariantRows: 0,
    retimedSourceRows: 0,
    retimedVariantRows: 0,
    samplesSkipped: [],
  };

  db.transaction(() => {
    for (const sample of samples) {
      const sourceTimestamps = computeFrameTimestamps(sample, framesPerVariant);
      const variantTimestamps = computeFrameTimestamps(sample, framesPerVariant, true);
      if (sourceTimestamps === null || variantTimestamps === null) {
        result.samplesSkipped.push({ sampleId: sample.id, reason: "no_duration" });
        continue;
      }

      for (let i = 0; i < sourceTimestamps.length; i++) {
        const ins = insertFrame.run(sample.id, null, i, sourceTimestamps[i]);
        if (ins.changes > 0) {
          result.insertedSourceRows += 1;
        } else {
          const upd = retimeSource.run(sourceTimestamps[i], sample.id, i, sourceTimestamps[i]);
          if (upd.changes > 0) result.retimedSourceRows += 1;
        }
      }

      const variants = db
        .prepare(
          `SELECT id FROM encoding_variants
            WHERE sample_id = ? AND status = 'done'
            ORDER BY position`
        )
        .all(sample.id) as Array<{ id: number }>;

      for (const variant of variants) {
        for (let i = 0; i < variantTimestamps.length; i++) {
          const ins = insertFrame.run(null, variant.id, i, variantTimestamps[i]);
          if (ins.changes > 0) {
            result.insertedVariantRows += 1;
          } else {
            const upd = retimeVariant.run(variantTimestamps[i], variant.id, i, variantTimestamps[i]);
            if (upd.changes > 0) result.retimedVariantRows += 1;
          }
        }
      }
    }
  })();

  return result;
}
