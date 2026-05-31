import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { makeTestDb, insertDisk } from "../helpers";
import {
  computeFrameTimestamps,
  ensureFrameRowsForSet,
} from "../../jobs/encoding/encoding-frames";

function createSampleSet(db: Database, opts: { samples: number; variantsPerSample: number; markVariantsDone?: boolean }): {
  setId: number;
  sampleIds: number[];
  variantIds: number[];
} {
  const diskId = insertDisk(db);
  const setId = (db
    .prepare(
      `INSERT INTO encoding_sample_sets (name, scratch_root) VALUES (?, ?) RETURNING id`
    )
    .get("test", "/scratch") as { id: number }).id;

  const sampleIds: number[] = [];
  const variantIds: number[] = [];
  for (let i = 0; i < opts.samples; i++) {
    const s = db
      .prepare(
        `INSERT INTO encoding_samples
           (set_id, position, source_disk_id, source_path,
            clip_start_seconds, clip_duration_seconds, source_duration_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(setId, i, diskId, `/a-${i}.mp4`, 10, 60, 120) as { id: number };
    sampleIds.push(s.id);
    for (let j = 0; j < opts.variantsPerSample; j++) {
      const v = db
        .prepare(
          `INSERT INTO encoding_variants
             (sample_id, position, codec, encoder, status)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id`
        )
        .get(
          s.id,
          j,
          "hevc",
          "libx265",
          opts.markVariantsDone ? "done" : "pending"
        ) as { id: number };
      variantIds.push(v.id);
    }
  }
  return { setId, sampleIds, variantIds };
}

describe("computeFrameTimestamps", () => {
  it("returns evenly-spaced midpoints across the clip window", () => {
    const ts = computeFrameTimestamps(
      { id: 1, clip_start_seconds: 10, clip_duration_seconds: 100, source_duration_seconds: null },
      5
    );
    // start=10, duration=100, midpoints at (i+0.5)/5 = 0.1, 0.3, 0.5, 0.7, 0.9
    expect(ts).toEqual([20, 40, 60, 80, 100]);
  });

  it("falls back to source_duration_seconds when no clip window is set", () => {
    const ts = computeFrameTimestamps(
      { id: 1, clip_start_seconds: null, clip_duration_seconds: null, source_duration_seconds: 200 },
      2
    );
    // start=0, duration=200, midpoints at 0.25 and 0.75 → 50 and 150
    expect(ts).toEqual([50, 150]);
  });

  it("uses clip_start_seconds even when there's no explicit clip duration", () => {
    const ts = computeFrameTimestamps(
      { id: 1, clip_start_seconds: 30, clip_duration_seconds: null, source_duration_seconds: 60 },
      1
    );
    // start=30, duration=60, midpoint at 0.5 → 30 + 30 = 60
    expect(ts).toEqual([60]);
  });

  it("returns null when no duration is available", () => {
    const ts = computeFrameTimestamps(
      { id: 1, clip_start_seconds: 5, clip_duration_seconds: null, source_duration_seconds: null },
      3
    );
    expect(ts).toBeNull();
  });

  it("returns null when duration is zero or negative", () => {
    expect(
      computeFrameTimestamps(
        { id: 1, clip_start_seconds: 0, clip_duration_seconds: 0, source_duration_seconds: null },
        3
      )
    ).toBeNull();
    expect(
      computeFrameTimestamps(
        { id: 1, clip_start_seconds: 0, clip_duration_seconds: -5, source_duration_seconds: null },
        3
      )
    ).toBeNull();
  });
});

describe("ensureFrameRowsForSet", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });

  it("creates N source frames per sample plus N frames per done variant", () => {
    const { setId, sampleIds, variantIds } = createSampleSet(db, {
      samples: 2,
      variantsPerSample: 3,
      markVariantsDone: true,
    });

    const result = ensureFrameRowsForSet(db, setId, 5);
    expect(result.insertedSourceRows).toBe(2 * 5);
    expect(result.insertedVariantRows).toBe(2 * 3 * 5);
    expect(result.samplesSkipped).toEqual([]);

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM encoding_frames`).get() as { n: number }).n;
    expect(total).toBe(2 * 5 + 2 * 3 * 5);

    // Each frame row has either sample_id XOR variant_id set.
    const both = db
      .prepare(`SELECT COUNT(*) AS n FROM encoding_frames WHERE sample_id IS NOT NULL AND variant_id IS NOT NULL`)
      .get() as { n: number };
    expect(both.n).toBe(0);
    const neither = db
      .prepare(`SELECT COUNT(*) AS n FROM encoding_frames WHERE sample_id IS NULL AND variant_id IS NULL`)
      .get() as { n: number };
    expect(neither.n).toBe(0);

    // First sample has 5 source frames at positions 0..4
    const sourcePositions = db
      .prepare(`SELECT position FROM encoding_frames WHERE sample_id = ? ORDER BY position`)
      .all(sampleIds[0]) as Array<{ position: number }>;
    expect(sourcePositions.map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);

    // First variant has 5 variant frames
    const variantCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM encoding_frames WHERE variant_id = ?`)
      .get(variantIds[0]) as { n: number }).n;
    expect(variantCount).toBe(5);
  });

  it("does not create variant frames for variants that are not done", () => {
    const { setId } = createSampleSet(db, {
      samples: 1,
      variantsPerSample: 4,
      markVariantsDone: false,
    });
    const result = ensureFrameRowsForSet(db, setId, 5);
    expect(result.insertedSourceRows).toBe(5);
    expect(result.insertedVariantRows).toBe(0);
  });

  it("is idempotent — running twice does not duplicate rows", () => {
    const { setId } = createSampleSet(db, {
      samples: 1,
      variantsPerSample: 2,
      markVariantsDone: true,
    });
    const first = ensureFrameRowsForSet(db, setId, 3);
    expect(first.insertedSourceRows).toBe(3);
    expect(first.insertedVariantRows).toBe(2 * 3);

    const second = ensureFrameRowsForSet(db, setId, 3);
    expect(second.insertedSourceRows).toBe(0);
    expect(second.insertedVariantRows).toBe(0);

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM encoding_frames`).get() as { n: number }).n;
    expect(total).toBe(3 + 2 * 3);
  });

  it("skips samples without any duration and reports them", () => {
    const diskId = insertDisk(db);
    const setId = (db
      .prepare(`INSERT INTO encoding_sample_sets (name, scratch_root) VALUES (?, ?) RETURNING id`)
      .get("test", "/scratch") as { id: number }).id;
    // Sample 0: no clip window, no source duration → skipped
    db.prepare(
      `INSERT INTO encoding_samples (set_id, position, source_disk_id, source_path) VALUES (?, ?, ?, ?)`
    ).run(setId, 0, diskId, "/a.mp4");
    // Sample 1: usable duration → processed
    const ok = db
      .prepare(
        `INSERT INTO encoding_samples
           (set_id, position, source_disk_id, source_path, source_duration_seconds)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      )
      .get(setId, 1, diskId, "/b.mp4", 30) as { id: number };

    const result = ensureFrameRowsForSet(db, setId, 4);
    expect(result.samplesSkipped).toHaveLength(1);
    expect(result.samplesSkipped[0].reason).toBe("no_duration");
    expect(result.insertedSourceRows).toBe(4);

    const okFrames = (db
      .prepare(`SELECT COUNT(*) AS n FROM encoding_frames WHERE sample_id = ?`)
      .get(ok.id) as { n: number }).n;
    expect(okFrames).toBe(4);
  });

  it("picks up newly-done variants on a re-run", () => {
    const { setId, variantIds } = createSampleSet(db, {
      samples: 1,
      variantsPerSample: 2,
      markVariantsDone: false,
    });
    // First run: no variants done, source frames only.
    let result = ensureFrameRowsForSet(db, setId, 3);
    expect(result.insertedVariantRows).toBe(0);

    // Mark one variant done, re-run.
    db.prepare(`UPDATE encoding_variants SET status = 'done' WHERE id = ?`).run(variantIds[0]);
    result = ensureFrameRowsForSet(db, setId, 3);
    expect(result.insertedVariantRows).toBe(3);
    expect(result.insertedSourceRows).toBe(0); // source rows were already in place
  });
});
