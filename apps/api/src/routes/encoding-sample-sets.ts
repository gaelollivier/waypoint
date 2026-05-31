import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { getDiskById } from "../disks/registry";
import { recordAudit, classifyActor } from "../lib/audit";

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
 * DELETE /api/encoding-sample-sets/:id — drop the set and all child variants
 * (cascade). Does NOT touch the scratch directory; the caller is responsible
 * for cleaning up `output_path` files on disk.
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
