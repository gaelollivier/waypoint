import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { recordAudit, classifyActor } from "../lib/audit";
import { getJobManager, registerRunner, unregisterRunner } from "../jobs";
import { EncodingSampleRunJobRunner } from "../jobs/encoding/encoding-sample-run-job";
import { EncodingFrameExtractJobRunner } from "../jobs/encoding/encoding-frame-extract-job";
import { deleteEncodingScratchFile, removeEmptyDirectoryInsideMount } from "../fs/disk-writes";

export const encodingSampleSetsRouter = new Hono();

// ─── Types ──────────────────────────────────────────────────────────────────

interface CreateSampleSetBody {
  name: string;
  notes?: string;
  scratchRoot: string;
  samples: Array<{
    sourceDiskId: number;
    sourcePath: string;
    clipStartSeconds?: number | null;
    clipDurationSeconds?: number | null;
    label?: string;
  }>;
  variants: Array<{
    codec: string;
    encoder: string;
    preset?: string | null;
    crf?: number | null;
    extraArgs?: string[];
    label?: string;
  }>;
}

interface SampleRow {
  id: number;
  set_id: number;
  position: number;
  source_disk_id: number;
  source_path: string;
  source_file_id: number | null;
  clip_start_seconds: number | null;
  clip_duration_seconds: number | null;
  label: string;
  source_size_bytes: number | null;
  source_duration_seconds: number | null;
  source_make: string | null;
  source_model: string | null;
  source_captured_at_unix: number | null;
}

interface VariantRow {
  id: number;
  sample_id: number;
  position: number;
  codec: string;
  encoder: string;
  preset: string | null;
  crf: number | null;
  extra_args_json: string | null;
  label: string;
  output_path: string | null;
  output_size_bytes: number | null;
  encode_seconds: number | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error_detail: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface SampleSetRow {
  id: number;
  name: string;
  notes: string;
  scratch_root: string;
  status: "pending" | "encoding" | "ready" | "archived";
  created_at: string;
}

interface FrameComparisonBatchBody {
  namePrefix?: string;
  rationale?: string;
}

interface FrameComparisonSampleRow {
  id: number;
  position: number;
  label: string;
}

interface FrameComparisonVariantRow {
  id: number;
  position: number;
  label: string;
  output_path: string;
  output_size_bytes: number | null;
  frame_count: number;
}

interface RankingMemberRow {
  sample_id: number;
  left_variant_id: number | null;
  right_variant_id: number | null;
  verdict:
    | "same"
    | "different"
    | "unsure"
    | "prefer_left"
    | "prefer_right"
    | "tie"
    | null;
}

interface VariantRankingStats {
  variantId: number;
  sampleId: number;
  position: number;
  codec: string;
  encoder: string;
  preset: string | null;
  crf: number | null;
  label: string;
  outputSizeBytes: number | null;
  encodeSeconds: number | null;
  comparisons: number;
  pending: number;
  wins: number;
  losses: number;
  ties: number;
  unsure: number;
  score: number;
  winRate: number | null;
  rank: number;
}

interface SampleRankingStats {
  sampleId: number;
  position: number;
  label: string;
  comparisons: {
    total: number;
    pending: number;
    preferLeft: number;
    preferRight: number;
    tie: number;
    unsure: number;
  };
  variants: VariantRankingStats[];
}

interface AggregateVariantRankingStats {
  position: number;
  codec: string;
  encoder: string;
  preset: string | null;
  crf: number | null;
  label: string;
  sampleCount: number;
  comparisons: number;
  pending: number;
  wins: number;
  losses: number;
  ties: number;
  unsure: number;
  score: number;
  winRate: number | null;
  rank: number;
}

// ─── Format helpers ─────────────────────────────────────────────────────────

function formatSampleSet(row: SampleSetRow) {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    scratchRoot: row.scratch_root,
    status: row.status,
    createdAt: row.created_at,
  };
}

function formatSampleSetSummary(row: SampleSetRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  };
}

function formatSample(row: SampleRow) {
  return {
    id: row.id,
    setId: row.set_id,
    position: row.position,
    sourceDiskId: row.source_disk_id,
    sourcePath: row.source_path,
    sourceFileId: row.source_file_id,
    clipStartSeconds: row.clip_start_seconds,
    clipDurationSeconds: row.clip_duration_seconds,
    label: row.label,
    sourceSizeBytes: row.source_size_bytes,
    sourceDurationSeconds: row.source_duration_seconds,
    sourceMake: row.source_make,
    sourceModel: row.source_model,
    sourceCapturedAtUnix: row.source_captured_at_unix,
  };
}

function formatVariant(row: VariantRow) {
  return {
    id: row.id,
    sampleId: row.sample_id,
    position: row.position,
    codec: row.codec,
    encoder: row.encoder,
    preset: row.preset,
    crf: row.crf,
    extraArgs: row.extra_args_json ? (JSON.parse(row.extra_args_json) as string[]) : [],
    label: row.label,
    outputPath: row.output_path,
    outputSizeBytes: row.output_size_bytes,
    encodeSeconds: row.encode_seconds,
    status: row.status,
    errorDetail: row.error_detail,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateBody(body: unknown): CreateSampleSetBody | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    return { error: "name is required" };
  }
  if (typeof b.scratchRoot !== "string" || !path.isAbsolute(b.scratchRoot)) {
    return { error: "scratchRoot must be an absolute path" };
  }
  if (!Array.isArray(b.samples) || b.samples.length === 0) {
    return { error: "samples must be a non-empty array" };
  }
  for (let i = 0; i < b.samples.length; i++) {
    const s = b.samples[i] as Record<string, unknown>;
    if (typeof s !== "object" || s === null) return { error: `sample ${i} must be an object` };
    if (!Number.isInteger(s.sourceDiskId) || (s.sourceDiskId as number) <= 0) {
      return { error: `sample ${i}: sourceDiskId must be a positive integer` };
    }
    if (typeof s.sourcePath !== "string" || !path.isAbsolute(s.sourcePath)) {
      return { error: `sample ${i}: sourcePath must be an absolute path` };
    }
    if (s.clipStartSeconds != null && typeof s.clipStartSeconds !== "number") {
      return { error: `sample ${i}: clipStartSeconds must be a number or null` };
    }
    if (s.clipDurationSeconds != null && typeof s.clipDurationSeconds !== "number") {
      return { error: `sample ${i}: clipDurationSeconds must be a number or null` };
    }
  }
  if (!Array.isArray(b.variants) || b.variants.length === 0) {
    return { error: "variants must be a non-empty array" };
  }
  for (let i = 0; i < b.variants.length; i++) {
    const v = b.variants[i] as Record<string, unknown>;
    if (typeof v !== "object" || v === null) return { error: `variant ${i} must be an object` };
    if (typeof v.codec !== "string" || v.codec.length === 0) {
      return { error: `variant ${i}: codec required` };
    }
    if (typeof v.encoder !== "string" || v.encoder.length === 0) {
      return { error: `variant ${i}: encoder required` };
    }
    if (v.preset != null && typeof v.preset !== "string") {
      return { error: `variant ${i}: preset must be a string or null` };
    }
    if (v.crf != null && typeof v.crf !== "number") {
      return { error: `variant ${i}: crf must be a number or null` };
    }
    if (v.extraArgs !== undefined && !Array.isArray(v.extraArgs)) {
      return { error: `variant ${i}: extraArgs must be an array of strings` };
    }
  }
  return b as unknown as CreateSampleSetBody;
}

function validateFrameComparisonBody(
  body: unknown
): FrameComparisonBatchBody | { error: string } {
  if (body === null || body === undefined) return {};
  if (typeof body !== "object") return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (b.namePrefix !== undefined && typeof b.namePrefix !== "string") {
    return { error: "namePrefix must be a string" };
  }
  if (b.rationale !== undefined && typeof b.rationale !== "string") {
    return { error: "rationale must be a string" };
  }
  return {
    namePrefix: b.namePrefix,
    rationale: b.rationale,
  } as FrameComparisonBatchBody;
}

function rankVariants<T extends { score: number; wins: number; losses: number; outputSizeBytes?: number | null; position: number }>(
  variants: T[]
): T[] {
  const sorted = [...variants].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    const aSize = a.outputSizeBytes ?? Number.POSITIVE_INFINITY;
    const bSize = b.outputSizeBytes ?? Number.POSITIVE_INFINITY;
    if (aSize !== bSize) return aSize - bSize;
    return a.position - b.position;
  });
  return sorted.map((variant, index) => ({ ...variant, rank: index + 1 }));
}

function withWinRate<T extends { wins: number; losses: number; ties: number; score: number }>(
  variant: T
): T & { winRate: number | null } {
  const decided = variant.wins + variant.losses + variant.ties;
  return {
    ...variant,
    winRate: decided === 0 ? null : variant.score / decided,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/encoding-sample-sets — list sample sets, newest first.
 */
encodingSampleSetsRouter.get("/", (c) => {
  const rows = getDb()
    .prepare(`SELECT * FROM encoding_sample_sets ORDER BY id DESC`)
    .all() as SampleSetRow[];
  return c.json({ sets: rows.map(formatSampleSet) });
});

/**
 * GET /api/encoding-sample-sets/:id — one set with its samples and variants.
 */
encodingSampleSetsRouter.get("/:id{[0-9]+}", (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb();
  const set = db
    .prepare(`SELECT * FROM encoding_sample_sets WHERE id = ?`)
    .get(id) as SampleSetRow | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const samples = db
    .prepare(`SELECT * FROM encoding_samples WHERE set_id = ? ORDER BY position`)
    .all(id) as SampleRow[];
  const variants = db
    .prepare(
      `SELECT v.* FROM encoding_variants v
        JOIN encoding_samples s ON s.id = v.sample_id
       WHERE s.set_id = ?
       ORDER BY s.position, v.position`
    )
    .all(id) as VariantRow[];

  return c.json({
    set: formatSampleSet(set),
    samples: samples.map(formatSample),
    variants: variants.map(formatVariant),
  });
});

/**
 * POST /api/encoding-sample-sets — register a sample set.
 *
 * Body:
 *   {
 *     name: string,
 *     notes?: string,
 *     scratchRoot: absolute path,
 *     samples: [{ sourceDiskId, sourcePath, clipStartSeconds?, clipDurationSeconds?, label? }],
 *     variants: [{ codec, encoder, preset?, crf?, extraArgs?, label? }]
 *   }
 *
 * For each sample we resolve the source file in the disk's latest scan to
 * cache size / duration / camera, and reject sources that don't resolve. The
 * variant matrix is materialised against every sample so we get
 * `samples.length × variants.length` pending encoding_variants rows.
 */
encodingSampleSetsRouter.post("/", async (c) => {
  const db = getDb();
  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: "invalid JSON body" }, 400);
  const v = validateBody(raw);
  if ("error" in v) return c.json({ error: v.error }, 400);

  const userAgent = c.req.header("User-Agent") ?? null;
  const actor = classifyActor(userAgent);

  // Resolve every source upfront. If any fails, refuse the whole batch.
  interface ResolvedSample {
    sourceDiskId: number;
    sourcePath: string;
    fileId: number;
    sizeBytes: number;
    durationSeconds: number | null;
    make: string | null;
    model: string | null;
    capturedAtUnix: number | null;
    clipStartSeconds: number | null;
    clipDurationSeconds: number | null;
    label: string;
  }

  const resolved: ResolvedSample[] = [];
  for (let i = 0; i < v.samples.length; i++) {
    const s = v.samples[i];
    const disk = getDiskById(db, s.sourceDiskId);
    if (!disk) {
      return c.json({ error: `sample ${i}: disk ${s.sourceDiskId} not found` }, 400);
    }
    if (disk.last_scan_job_id === null) {
      return c.json({ error: `sample ${i}: disk ${s.sourceDiskId} has no scans` }, 400);
    }
    const file = db
      .prepare(
        `SELECT f.id, f.size_bytes,
                mm.duration_seconds, mm.make, mm.model, mm.captured_at_unix
           FROM files f
           LEFT JOIN media_metadata mm ON mm.file_id = f.id
          WHERE f.scan_id = ? AND f.path = ?
          LIMIT 1`
      )
      .get(disk.last_scan_job_id, s.sourcePath) as
      | {
          id: number;
          size_bytes: number;
          duration_seconds: number | null;
          make: string | null;
          model: string | null;
          captured_at_unix: number | null;
        }
      | null;
    if (!file) {
      return c.json(
        { error: `sample ${i}: file not found at ${s.sourcePath} on disk ${s.sourceDiskId}` },
        400
      );
    }
    resolved.push({
      sourceDiskId: s.sourceDiskId,
      sourcePath: s.sourcePath,
      fileId: file.id,
      sizeBytes: file.size_bytes,
      durationSeconds: file.duration_seconds,
      make: file.make,
      model: file.model,
      capturedAtUnix: file.captured_at_unix,
      clipStartSeconds: s.clipStartSeconds ?? null,
      clipDurationSeconds: s.clipDurationSeconds ?? null,
      label: s.label ?? "",
    });
  }

  const setId = db.transaction(() => {
    const set = db
      .prepare(
        `INSERT INTO encoding_sample_sets (name, notes, scratch_root)
         VALUES (?, ?, ?) RETURNING id`
      )
      .get(v.name, v.notes ?? "", v.scratchRoot) as { id: number };

    const insertSample = db.prepare(
      `INSERT INTO encoding_samples
        (set_id, position, source_disk_id, source_path, source_file_id,
         clip_start_seconds, clip_duration_seconds, label,
         source_size_bytes, source_duration_seconds,
         source_make, source_model, source_captured_at_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    );
    const insertVariant = db.prepare(
      `INSERT INTO encoding_variants
        (sample_id, position, codec, encoder, preset, crf, extra_args_json, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const sampleIds: number[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const row = insertSample.get(
        set.id,
        i,
        r.sourceDiskId,
        r.sourcePath,
        r.fileId,
        r.clipStartSeconds,
        r.clipDurationSeconds,
        r.label,
        r.sizeBytes,
        r.durationSeconds,
        r.make,
        r.model,
        r.capturedAtUnix
      ) as { id: number };
      sampleIds.push(row.id);
    }

    for (const sampleId of sampleIds) {
      for (let j = 0; j < v.variants.length; j++) {
        const varr = v.variants[j];
        insertVariant.run(
          sampleId,
          j,
          varr.codec,
          varr.encoder,
          varr.preset ?? null,
          varr.crf ?? null,
          varr.extraArgs ? JSON.stringify(varr.extraArgs) : null,
          varr.label ?? ""
        );
      }
    }

    recordAudit(db, {
      action: "encoding_sample_set_create",
      actor,
      userAgent,
      targetKind: "encoding_sample_set",
      targetId: set.id,
      after: {
        id: set.id,
        name: v.name,
        scratchRoot: v.scratchRoot,
        sampleCount: resolved.length,
        variantCount: v.variants.length,
      },
      metadata: {
        samples: resolved.map((r) => ({
          sourcePath: r.sourcePath,
          sourceDiskId: r.sourceDiskId,
          clipStartSeconds: r.clipStartSeconds,
          clipDurationSeconds: r.clipDurationSeconds,
        })),
        variants: v.variants,
      },
    });
    return set.id;
  })();

  return c.json({ id: setId }, 201);
});

/**
 * POST /api/encoding-sample-sets/:id/run — kick off the encoder job.
 *
 * Body (all optional):
 *   { concurrency?: number  // 1-12, default 2 }
 *
 * Returns 202 + { jobId }. Idempotent in the sense that pending variants
 * are picked up if a previous run halted; already-done variants are skipped.
 */
encodingSampleSetsRouter.post("/:id{[0-9]+}/run", async (c) => {
  const setId = Number(c.req.param("id"));
  const db = getDb();
  const set = db
    .prepare(`SELECT id FROM encoding_sample_sets WHERE id = ?`)
    .get(setId) as { id: number } | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ concurrency?: number }>()
    .catch(() => ({} as { concurrency?: number }));
  const concurrency = Math.max(1, Math.min(12, body.concurrency ?? 2));

  // Refuse if a run is already active for this set.
  const active = db
    .prepare(
      `SELECT id FROM jobs
        WHERE type = 'encoding_sample_run'
          AND status IN ('queued', 'running', 'paused')
          AND json_extract(payload_json, '$.setId') = ?
        LIMIT 1`
    )
    .get(setId) as { id: number } | null;
  if (active) {
    return c.json({ error: `encoding run already in flight: job ${active.id}` }, 409);
  }

  const jm = getJobManager();
  const job = jm.createJob({
    type: "encoding_sample_run",
    payload: { setId, concurrency },
  });

  const runner = new EncodingSampleRunJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    setId,
    concurrency,
  });
  registerRunner(job.id, runner);
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});

/**
 * POST /api/encoding-sample-sets/:id/extract-frames — kick off the frame
 * extraction job. Pre-creates `encoding_frames` rows for every sample (source
 * frames) and every variant whose status is 'done', then extracts JPEGs via
 * ffmpeg.
 *
 * Body (all optional):
 *   { framesPerVariant?: number  // 1-20, default 5
 *     concurrency?: number       // 1-8,  default 4 }
 *
 * Returns 202 + { jobId }. Refuses if another extract is in flight for this
 * set, or if the encoder job for this set is still running (variants might
 * still be encoding and we'd race them).
 */
encodingSampleSetsRouter.post("/:id{[0-9]+}/extract-frames", async (c) => {
  const setId = Number(c.req.param("id"));
  const db = getDb();
  const set = db
    .prepare(`SELECT id FROM encoding_sample_sets WHERE id = ?`)
    .get(setId) as { id: number } | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ framesPerVariant?: number; concurrency?: number }>()
    .catch(() => ({} as { framesPerVariant?: number; concurrency?: number }));
  const framesPerVariant = Math.max(1, Math.min(20, body.framesPerVariant ?? 5));
  const concurrency = Math.max(1, Math.min(8, body.concurrency ?? 4));

  // Refuse if a frame-extract job is already in flight for this set, or the
  // encoder is still finishing variants we'd want to sample.
  const activeFrames = db
    .prepare(
      `SELECT id FROM jobs
        WHERE type = 'encoding_frame_extract'
          AND status IN ('queued', 'running', 'paused')
          AND json_extract(payload_json, '$.setId') = ?
        LIMIT 1`
    )
    .get(setId) as { id: number } | null;
  if (activeFrames) {
    return c.json(
      { error: `frame extraction already in flight: job ${activeFrames.id}` },
      409
    );
  }
  const activeEncode = db
    .prepare(
      `SELECT id FROM jobs
        WHERE type = 'encoding_sample_run'
          AND status IN ('queued', 'running', 'paused')
          AND json_extract(payload_json, '$.setId') = ?
        LIMIT 1`
    )
    .get(setId) as { id: number } | null;
  if (activeEncode) {
    return c.json(
      { error: `encode run still in flight (job ${activeEncode.id}); wait for it to finish` },
      409
    );
  }

  const userAgent = c.req.header("User-Agent") ?? null;
  const actor = classifyActor(userAgent);

  const jm = getJobManager();
  const job = jm.createJob({
    type: "encoding_frame_extract",
    payload: { setId, framesPerVariant, concurrency },
  });

  recordAudit(db, {
    action: "encoding_frame_extract_start",
    actor,
    userAgent,
    targetKind: "encoding_sample_set",
    targetId: setId,
    after: { jobId: job.id, framesPerVariant, concurrency },
    revertible: false,
  });

  const runner = new EncodingFrameExtractJobRunner({
    jobId: job.id,
    jobManager: jm,
    db,
    setId,
    framesPerVariant,
    concurrency,
  });
  registerRunner(job.id, runner);
  runner.start().finally(() => unregisterRunner(job.id));

  return c.json({ jobId: job.id }, 202);
});

/**
 * GET /api/encoding-sample-sets/:id/frames — list every `encoding_frames` row
 * for the set. Used by the comparison UI to know which frames to render and
 * by callers checking extract progress.
 *
 * Returns frames ordered (sample position → source frames first → variant
 * position → frame position), so the UI can stream-render top-down without
 * having to re-sort.
 */
encodingSampleSetsRouter.get("/:id{[0-9]+}/frames", (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb();
  const set = db
    .prepare(`SELECT id FROM encoding_sample_sets WHERE id = ?`)
    .get(id) as { id: number } | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const rows = db
    .prepare(
      `SELECT f.id, f.sample_id, f.variant_id, f.position, f.at_seconds,
              f.output_path, f.status, f.error_detail,
              f.started_at, f.completed_at,
              COALESCE(f.sample_id, v.sample_id) AS resolved_sample_id,
              s.position AS sample_position,
              v.position AS variant_position
         FROM encoding_frames f
         LEFT JOIN encoding_variants v ON v.id = f.variant_id
         LEFT JOIN encoding_samples s ON s.id = COALESCE(f.sample_id, v.sample_id)
        WHERE s.set_id = ?
        ORDER BY s.position,
                 f.variant_id IS NULL DESC,
                 v.position,
                 f.position`
    )
    .all(id) as Array<{
      id: number;
      sample_id: number | null;
      variant_id: number | null;
      position: number;
      at_seconds: number;
      output_path: string | null;
      status: "pending" | "running" | "done" | "failed";
      error_detail: string | null;
      started_at: string | null;
      completed_at: string | null;
      resolved_sample_id: number;
      sample_position: number;
      variant_position: number | null;
    }>;

  return c.json({
    frames: rows.map((r) => ({
      id: r.id,
      sampleId: r.sample_id,
      variantId: r.variant_id,
      resolvedSampleId: r.resolved_sample_id,
      position: r.position,
      atSeconds: r.at_seconds,
      outputPath: r.output_path,
      status: r.status,
      errorDetail: r.error_detail,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    })),
  });
});

/**
 * GET /api/encoding-sample-sets/:id/rankings
 *
 * Aggregates encoding-frame comparison verdicts into per-sample and
 * cross-sample variant rankings. The response intentionally returns variant
 * settings and metrics only, not source or output paths.
 */
encodingSampleSetsRouter.get("/:id{[0-9]+}/rankings", (c) => {
  const setId = Number(c.req.param("id"));
  const db = getDb();
  const set = db
    .prepare(`SELECT * FROM encoding_sample_sets WHERE id = ?`)
    .get(setId) as SampleSetRow | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const samples = db
    .prepare(
      `SELECT id, position, label
         FROM encoding_samples
        WHERE set_id = ?
        ORDER BY position`
    )
    .all(setId) as FrameComparisonSampleRow[];

  const variants = db
    .prepare(
      `SELECT v.id, v.sample_id, v.position, v.codec, v.encoder, v.preset,
              v.crf, v.label, v.output_size_bytes, v.encode_seconds
         FROM encoding_variants v
         JOIN encoding_samples s ON s.id = v.sample_id
        WHERE s.set_id = ?
        ORDER BY s.position, v.position`
    )
    .all(setId) as Array<
    Pick<
      VariantRow,
      | "id"
      | "sample_id"
      | "position"
      | "codec"
      | "encoder"
      | "preset"
      | "crf"
      | "label"
      | "output_size_bytes"
      | "encode_seconds"
    >
  >;

  const sampleStats = new Map<number, SampleRankingStats>();
  for (const sample of samples) {
    sampleStats.set(sample.id, {
      sampleId: sample.id,
      position: sample.position,
      label: sample.label,
      comparisons: {
        total: 0,
        pending: 0,
        preferLeft: 0,
        preferRight: 0,
        tie: 0,
        unsure: 0,
      },
      variants: [],
    });
  }

  const variantStats = new Map<number, VariantRankingStats>();
  for (const variant of variants) {
    const sample = sampleStats.get(variant.sample_id);
    if (sample === undefined) {
      throw new Error("invariant: variant belongs to a sample outside the set");
    }
    const stats: VariantRankingStats = {
      variantId: variant.id,
      sampleId: variant.sample_id,
      position: variant.position,
      codec: variant.codec,
      encoder: variant.encoder,
      preset: variant.preset,
      crf: variant.crf,
      label: variant.label,
      outputSizeBytes: variant.output_size_bytes,
      encodeSeconds: variant.encode_seconds,
      comparisons: 0,
      pending: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      unsure: 0,
      score: 0,
      winRate: null,
      rank: 0,
    };
    variantStats.set(variant.id, stats);
    sample.variants.push(stats);
  }

  if (samples.length > 0) {
    const placeholders = samples.map(() => "?").join(", ");
    const members = db
      .prepare(
        `SELECT b.sample_id, m.left_variant_id, m.right_variant_id, m.verdict
           FROM comparison_batches b
           JOIN comparison_members m ON m.batch_id = b.id
          WHERE b.kind = 'encoding_frames'
            AND b.sample_id IN (${placeholders})
          ORDER BY b.sample_id, b.id, m.position`
      )
      .all(...samples.map((s) => s.id)) as RankingMemberRow[];

    for (const member of members) {
      const sample = sampleStats.get(member.sample_id);
      if (sample === undefined) {
        throw new Error("invariant: comparison batch sample is outside the set");
      }
      if (member.left_variant_id === null || member.right_variant_id === null) {
        throw new Error("invariant: encoding comparison member is missing variant ids");
      }
      const left = variantStats.get(member.left_variant_id);
      const right = variantStats.get(member.right_variant_id);
      if (left === undefined || right === undefined) {
        throw new Error("invariant: encoding comparison member references a variant outside the set");
      }

      sample.comparisons.total++;
      left.comparisons++;
      right.comparisons++;

      switch (member.verdict) {
        case null:
          sample.comparisons.pending++;
          left.pending++;
          right.pending++;
          break;
        case "prefer_left":
          sample.comparisons.preferLeft++;
          left.wins++;
          right.losses++;
          left.score += 1;
          break;
        case "prefer_right":
          sample.comparisons.preferRight++;
          right.wins++;
          left.losses++;
          right.score += 1;
          break;
        case "tie":
          sample.comparisons.tie++;
          left.ties++;
          right.ties++;
          left.score += 0.5;
          right.score += 0.5;
          break;
        case "unsure":
          sample.comparisons.unsure++;
          left.unsure++;
          right.unsure++;
          break;
        case "same":
        case "different":
          throw new Error("invariant: dedup verdict stored on encoding comparison member");
      }
    }
  }

  const rankedSamples = Array.from(sampleStats.values()).map((sample) => ({
    ...sample,
    variants: rankVariants(sample.variants.map(withWinRate)),
  }));

  const aggregateByPosition = new Map<number, AggregateVariantRankingStats>();
  for (const variant of variantStats.values()) {
    const existing = aggregateByPosition.get(variant.position);
    if (existing === undefined) {
      aggregateByPosition.set(variant.position, {
        position: variant.position,
        codec: variant.codec,
        encoder: variant.encoder,
        preset: variant.preset,
        crf: variant.crf,
        label: variant.label,
        sampleCount: 1,
        comparisons: variant.comparisons,
        pending: variant.pending,
        wins: variant.wins,
        losses: variant.losses,
        ties: variant.ties,
        unsure: variant.unsure,
        score: variant.score,
        winRate: null,
        rank: 0,
      });
    } else {
      existing.sampleCount++;
      existing.comparisons += variant.comparisons;
      existing.pending += variant.pending;
      existing.wins += variant.wins;
      existing.losses += variant.losses;
      existing.ties += variant.ties;
      existing.unsure += variant.unsure;
      existing.score += variant.score;
    }
  }

  const aggregateVariants = rankVariants(
    Array.from(aggregateByPosition.values()).map(withWinRate)
  );

  return c.json({
    set: formatSampleSetSummary(set),
    aggregate: { variants: aggregateVariants },
    samples: rankedSamples,
  });
});

/**
 * POST /api/encoding-sample-sets/:id/frame-comparison-batches
 *
 * Builds one blinded `comparison_batches.kind='encoding_frames'` batch per
 * sample that has source frames plus at least two completed variants with
 * extracted frames. Members are all pairwise variant combinations for that
 * sample. The compare UI uses the variant foreign keys to render the frame
 * grids; the path columns still point at the renderable encoded outputs.
 */
encodingSampleSetsRouter.post("/:id{[0-9]+}/frame-comparison-batches", async (c) => {
  const setId = Number(c.req.param("id"));
  const db = getDb();
  const set = db
    .prepare(`SELECT * FROM encoding_sample_sets WHERE id = ?`)
    .get(setId) as SampleSetRow | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const parsed = validateFrameComparisonBody(
    await c.req.json<unknown>().catch(() => ({}))
  );
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const samples = db
    .prepare(
      `SELECT id, position, label
         FROM encoding_samples
        WHERE set_id = ?
        ORDER BY position`
    )
    .all(setId) as FrameComparisonSampleRow[];

  const userAgent = c.req.header("User-Agent") ?? null;
  const actor = classifyActor(userAgent);
  const skipped: Array<{ sampleId: number; reason: string }> = [];
  const created: Array<{ id: number; sampleId: number; memberCount: number }> = [];

  db.transaction(() => {
    for (const sample of samples) {
      const sourceFrameCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM encoding_frames
              WHERE sample_id = ?
                AND status = 'done'
                AND output_path IS NOT NULL`
          )
          .get(sample.id) as { n: number }
      ).n;
      if (sourceFrameCount === 0) {
        skipped.push({ sampleId: sample.id, reason: "no_source_frames" });
        continue;
      }

      const variants = db
        .prepare(
          `SELECT v.id, v.position, v.label, v.output_path, v.output_size_bytes,
                  COUNT(f.id) AS frame_count
             FROM encoding_variants v
             JOIN encoding_frames f
               ON f.variant_id = v.id
              AND f.status = 'done'
              AND f.output_path IS NOT NULL
            WHERE v.sample_id = ?
              AND v.status = 'done'
              AND v.output_path IS NOT NULL
            GROUP BY v.id
           HAVING frame_count = ?
            ORDER BY v.position`
        )
        .all(sample.id, sourceFrameCount) as FrameComparisonVariantRow[];

      if (variants.length < 2) {
        skipped.push({ sampleId: sample.id, reason: "fewer_than_two_ready_variants" });
        continue;
      }

      const namePrefix =
        parsed.namePrefix?.trim() ||
        `${set.name} frame comparison`;
      const name = `${namePrefix} - sample ${sample.position + 1}`;
      const rationale =
        parsed.rationale ??
        "Blind frame comparison between completed encoding variants.";
      const batch = db
        .prepare(
          `INSERT INTO comparison_batches (name, rationale, kind, sample_id)
           VALUES (?, ?, 'encoding_frames', ?)
           RETURNING id`
        )
        .get(name, rationale, sample.id) as { id: number };

      const insertMember = db.prepare(
        `INSERT INTO comparison_members
           (batch_id, position,
            left_path, left_size_bytes, left_variant_id,
            right_path, right_size_bytes, right_variant_id,
            note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      let position = 0;
      for (let i = 0; i < variants.length; i++) {
        for (let j = i + 1; j < variants.length; j++) {
          const left = variants[i];
          const right = variants[j];
          insertMember.run(
            batch.id,
            position,
            left.output_path,
            left.output_size_bytes,
            left.id,
            right.output_path,
            right.output_size_bytes,
            right.id,
            `sample ${sample.position + 1}, variant pair ${position + 1}`
          );
          position += 1;
        }
      }

      recordAudit(db, {
        action: "comparison_batch_create",
        actor,
        userAgent,
        targetKind: "comparison_batch",
        targetId: batch.id,
        after: {
          id: batch.id,
          name,
          rationale,
          kind: "encoding_frames",
          sampleId: sample.id,
          memberCount: position,
        },
        metadata: {
          setId,
          sampleId: sample.id,
          variantIds: variants.map((v) => v.id),
        },
      });

      created.push({ id: batch.id, sampleId: sample.id, memberCount: position });
    }
  })();

  if (created.length === 0) {
    return c.json(
      {
        error: "no samples have enough completed frame data to compare",
        skipped,
      },
      409
    );
  }

  return c.json({ setId, batches: created, skipped }, 201);
});

/**
 * DELETE /api/encoding-sample-sets/:id/scratch — remove every encoder /
 * frame-extraction artifact that lives under this set's scratch root, then
 * remove the now-empty `sample-<sid>/` and `set-<id>/` directory hulls.
 *
 * Guarded by the `disk-writes.ts` gateway: every unlink validates that the
 * target is under the recorded `scratch_root` and matches the
 * `variant-NNN.<ext>` / `frame-NNN.jpg` naming pattern. Anything else is
 * refused, so a typo in the scratch_root or a corrupted variant row cannot
 * cascade outside the scratch tree.
 *
 * Does NOT delete the sample-set row itself — use `DELETE
 * /api/encoding-sample-sets/:id` for that. Splitting the two ops keeps the
 * blast radius of "drop the bytes on disk" separate from "drop the DB
 * record" so a botched cleanup doesn't lose the registration metadata.
 */
encodingSampleSetsRouter.delete("/:id{[0-9]+}/scratch", async (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb();
  const userAgent = c.req.header("User-Agent") ?? null;

  const set = db
    .prepare(`SELECT id, scratch_root FROM encoding_sample_sets WHERE id = ?`)
    .get(id) as { id: number; scratch_root: string } | null;
  if (!set) return c.json({ error: "Not found" }, 404);

  const variants = db
    .prepare(
      `SELECT v.id, v.sample_id, v.output_path
         FROM encoding_variants v
         JOIN encoding_samples s ON s.id = v.sample_id
        WHERE s.set_id = ?
          AND v.output_path IS NOT NULL`
    )
    .all(id) as Array<{ id: number; sample_id: number; output_path: string }>;

  const frames = db
    .prepare(
      `SELECT f.id, f.sample_id, f.variant_id, f.output_path,
              COALESCE(f.sample_id, v.sample_id) AS resolved_sample_id
         FROM encoding_frames f
         LEFT JOIN encoding_variants v ON v.id = f.variant_id
         LEFT JOIN encoding_samples s ON s.id = COALESCE(f.sample_id, v.sample_id)
        WHERE s.set_id = ?
          AND f.output_path IS NOT NULL`
    )
    .all(id) as Array<{
      id: number;
      sample_id: number | null;
      variant_id: number | null;
      output_path: string;
      resolved_sample_id: number;
    }>;

  const sampleIds = new Set<number>();
  // Sub-dirs to attempt to rmdir after their contents are gone:
  // every variant whose frames we unlinked needs `sample-<sid>/variant-<vid>/`
  // cleaned, plus `sample-<sid>/source/` if any source frames were unlinked.
  const variantFrameDirs = new Set<string>(); // `${sampleId}:${variantId}`
  const sourceFrameDirs = new Set<number>();  // sampleId
  let deletedFileCount = 0;
  const errors: Array<{
    kind: "variant" | "frame";
    id: number;
    outputPath: string;
    error: string;
  }> = [];

  for (const f of frames) {
    sampleIds.add(f.resolved_sample_id);
    if (f.variant_id !== null) {
      variantFrameDirs.add(`${f.resolved_sample_id}:${f.variant_id}`);
    } else {
      sourceFrameDirs.add(f.resolved_sample_id);
    }
    try {
      await deleteEncodingScratchFile({
        filePath: f.output_path,
        scratchRoot: set.scratch_root,
      });
      deletedFileCount += 1;
      db.transaction(() => {
        // Reset to pending so a subsequent extract-frames run re-creates the
        // bytes without having to delete the row first.
        db.prepare(
          `UPDATE encoding_frames
              SET output_path = NULL,
                  status = 'pending',
                  error_detail = NULL,
                  started_at = NULL,
                  completed_at = NULL
            WHERE id = ?`
        ).run(f.id);
        recordAudit(db, {
          action: "encoding_frame_scratch_delete",
          actor: classifyActor(userAgent),
          userAgent,
          targetKind: "encoding_frame",
          targetId: f.id,
          before: { outputPath: f.output_path },
          metadata: {
            setId: id,
            sampleId: f.sample_id,
            variantId: f.variant_id,
          },
        });
      })();
    } catch (err) {
      errors.push({
        kind: "frame",
        id: f.id,
        outputPath: f.output_path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const v of variants) {
    sampleIds.add(v.sample_id);
    try {
      await deleteEncodingScratchFile({
        filePath: v.output_path,
        scratchRoot: set.scratch_root,
      });
      deletedFileCount += 1;
      db.transaction(() => {
        db.prepare(
          `UPDATE encoding_variants SET output_path = NULL, output_size_bytes = NULL WHERE id = ?`
        ).run(v.id);
        recordAudit(db, {
          action: "encoding_variant_scratch_delete",
          actor: classifyActor(userAgent),
          userAgent,
          targetKind: "encoding_variant",
          targetId: v.id,
          before: { outputPath: v.output_path },
          metadata: { setId: id, sampleId: v.sample_id },
        });
      })();
    } catch (err) {
      // File missing is the most common error here ("already cleaned by
      // hand") — report and keep going so the rest still tidy up.
      errors.push({
        kind: "variant",
        id: v.id,
        outputPath: v.output_path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Empty directory hulls. We use the existing rmdir-only gateway so any
  // unexpected non-encoding file inside makes the directory removal fail
  // safely — leaving the artifact in place rather than recursing.
  //
  // Order matters: deepest first (frame subdirs → sample dirs → set dir).
  let removedDirCount = 0;
  for (const key of variantFrameDirs) {
    const [sampleIdStr, variantIdStr] = key.split(":");
    try {
      await removeEmptyDirectoryInsideMount({
        directoryPath: path.join(
          set.scratch_root,
          `set-${id}`,
          `sample-${sampleIdStr}`,
          `variant-${variantIdStr}`
        ),
        diskMountPath: set.scratch_root,
      });
      removedDirCount += 1;
    } catch {
      // Non-empty or missing — leave it.
    }
  }
  for (const sampleId of sourceFrameDirs) {
    try {
      await removeEmptyDirectoryInsideMount({
        directoryPath: path.join(
          set.scratch_root,
          `set-${id}`,
          `sample-${sampleId}`,
          "source"
        ),
        diskMountPath: set.scratch_root,
      });
      removedDirCount += 1;
    } catch {
      // ditto
    }
  }
  for (const sampleId of sampleIds) {
    try {
      await removeEmptyDirectoryInsideMount({
        directoryPath: path.join(set.scratch_root, `set-${id}`, `sample-${sampleId}`),
        diskMountPath: set.scratch_root,
      });
      removedDirCount += 1;
    } catch {
      // ditto
    }
  }
  try {
    await removeEmptyDirectoryInsideMount({
      directoryPath: path.join(set.scratch_root, `set-${id}`),
      diskMountPath: set.scratch_root,
    });
    removedDirCount += 1;
  } catch {
    // ditto
  }

  return c.json({
    id,
    deletedFiles: deletedFileCount,
    removedDirectories: removedDirCount,
    errors,
  });
});

/**
 * DELETE /api/encoding-sample-sets/:id — drop the set and all child variants
 * (cascade). Does NOT touch the scratch directory; call DELETE /:id/scratch
 * first if you also want to remove encoded outputs.
 */
encodingSampleSetsRouter.delete("/:id{[0-9]+}", (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb();
  const userAgent = c.req.header("User-Agent") ?? null;

  const changed = db.transaction(() => {
    const set = db
      .prepare(`SELECT * FROM encoding_sample_sets WHERE id = ?`)
      .get(id) as SampleSetRow | null;
    if (!set) return 0;
    const samples = db
      .prepare(`SELECT * FROM encoding_samples WHERE set_id = ?`)
      .all(id) as SampleRow[];
    const variants = db
      .prepare(
        `SELECT v.* FROM encoding_variants v JOIN encoding_samples s ON s.id = v.sample_id WHERE s.set_id = ?`
      )
      .all(id) as VariantRow[];
    const res = db.prepare(`DELETE FROM encoding_sample_sets WHERE id = ?`).run(id);

    recordAudit(db, {
      action: "encoding_sample_set_delete",
      actor: classifyActor(userAgent),
      userAgent,
      targetKind: "encoding_sample_set",
      targetId: id,
      before: {
        set: formatSampleSet(set),
        samples: samples.map(formatSample),
        variants: variants.map(formatVariant),
      },
    });
    return res.changes;
  })();

  if (changed === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ id, deleted: true });
});
