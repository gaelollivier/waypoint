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
  samplesSkipped: SampleSkippedReason[];
}

/**
 * Returns the N timestamps (seconds, absolute from source file start) at
 * which to extract frames for a given sample. Returns null when the sample
 * has no usable duration (no clip window AND no cached source duration).
 *
 * Timestamps are placed at the center of N equal sub-intervals:
 *   t_i = start + ((i + 0.5) / N) * duration
 * so frame 0 is at +5% of duration when N=10, not exactly at t=start (which
 * is often a black frame or a hard cut).
 */
export function computeFrameTimestamps(
  sample: SampleTiming,
  count: number
): number[] | null {
  const start = sample.clip_start_seconds ?? 0;
  const duration =
    sample.clip_duration_seconds ?? sample.source_duration_seconds ?? null;
  if (duration === null || duration <= 0) return null;
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
 * Existing rows are left untouched (INSERT OR IGNORE on the unique index)
 * so per-frame status survives re-runs. Samples whose duration we can't
 * determine are skipped and surfaced in the returned `samplesSkipped` list
 * so the caller can log them.
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

  const result: EnsureFramesResult = {
    insertedSourceRows: 0,
    insertedVariantRows: 0,
    samplesSkipped: [],
  };

  db.transaction(() => {
    for (const sample of samples) {
      const timestamps = computeFrameTimestamps(sample, framesPerVariant);
      if (timestamps === null) {
        result.samplesSkipped.push({ sampleId: sample.id, reason: "no_duration" });
        continue;
      }

      for (let i = 0; i < timestamps.length; i++) {
        const r = insertFrame.run(sample.id, null, i, timestamps[i]);
        if (r.changes > 0) result.insertedSourceRows += 1;
      }

      const variants = db
        .prepare(
          `SELECT id FROM encoding_variants
            WHERE sample_id = ? AND status = 'done'
            ORDER BY position`
        )
        .all(sample.id) as Array<{ id: number }>;

      for (const variant of variants) {
        for (let i = 0; i < timestamps.length; i++) {
          const r = insertFrame.run(null, variant.id, i, timestamps[i]);
          if (r.changes > 0) result.insertedVariantRows += 1;
        }
      }
    }
  })();

  return result;
}
