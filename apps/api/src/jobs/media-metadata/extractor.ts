/**
 * Media metadata extraction — pure parsers + an I/O dispatcher.
 *
 * The pure parsers (`parseImageExif`, `parseVideoFfprobeJson`) take already-
 * loaded bytes or already-spawned tool output and return a normalised
 * {@link ExtractedMetadata}. They have no filesystem dependency, which makes
 * them trivial to unit-test against fixture buffers.
 *
 * The dispatcher (`extractFromPath`) classifies a file by extension, loads
 * the bytes / spawns ffprobe via the disk-reads gateway, and hands off to the
 * appropriate pure parser.
 *
 * The output schema mirrors the `media_metadata` SQL table:
 *   datetime_original   — ISO-8601 (no timezone offset, treated as wall clock)
 *   datetime_source     — where the timestamp came from (exif / quicktime / none)
 *   captured_at_unix    — unix seconds, set iff datetime_original is set
 *   make / model        — camera vendor + model
 *   extraction_error    — non-null when extraction itself failed
 */

import exifr from "exifr";
import { readFileAll, probeVideoMetadata } from "../../fs/disk-reads";

export type DatetimeSource = "exif" | "quicktime" | "sidecar" | "mtime" | "none";

export interface ExtractedMetadata {
  datetimeOriginal: string | null;
  datetimeSource: DatetimeSource;
  capturedAtUnix: number | null;
  make: string | null;
  model: string | null;
  /**
   * Video container duration in seconds (float). Always null for images.
   * Combined with `capturedAtUnix`, duration gives a near-unique match key
   * for videos even when Make/Model are stripped by re-encoding.
   */
  durationSeconds: number | null;
  extractionError: string | null;
}

// ---------------------------------------------------------------------------
// Extension classification
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".heic", ".heif",
  ".tif", ".tiff", ".webp", ".gif", ".bmp",
  ".cr2", ".cr3", ".arw", ".nef", ".raf", ".rw2", ".dng",
]);

const VIDEO_EXTS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".3gp",
  ".avi", ".mts", ".m2ts",
]);

export type MediaKind = "image" | "video" | "unsupported";

export function classifyByExtension(filename: string): MediaKind {
  const i = filename.lastIndexOf(".");
  if (i === -1) return "unsupported";
  const ext = filename.slice(i).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function nonEmpty(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

/**
 * Convert a date string from EXIF or QuickTime into ISO + unix seconds. We
 * preserve the original wall-clock interpretation: EXIF DateTimeOriginal has
 * no timezone, so we accept whatever exifr emits (UTC ISO with `Z`); QuickTime
 * `date` includes an offset, so we parse it as-is. The captured_at_unix value
 * is whatever Date.parse() yields for the produced ISO — close enough for
 * tolerance-based joining without trying to second-guess camera TZ settings.
 */
function toIsoAndUnix(input: unknown): { iso: string; unix: number } | null {
  if (input instanceof Date) {
    const t = input.getTime();
    if (!Number.isFinite(t)) return null;
    return { iso: input.toISOString(), unix: Math.floor(t / 1000) };
  }
  if (typeof input === "string") {
    const s = input.trim();
    if (s.length === 0) return null;
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    return { iso: new Date(t).toISOString(), unix: Math.floor(t / 1000) };
  }
  return null;
}

const EMPTY: ExtractedMetadata = {
  datetimeOriginal: null,
  datetimeSource: "none",
  capturedAtUnix: null,
  make: null,
  model: null,
  durationSeconds: null,
  extractionError: null,
};

// ---------------------------------------------------------------------------
// Pure parser: image EXIF
// ---------------------------------------------------------------------------

/**
 * Parses EXIF from a fully-loaded image buffer. Picks DateTimeOriginal first,
 * falling back to CreateDate. Returns an EMPTY result with the relevant
 * fields nulled out if no EXIF block is present (which is common for
 * screenshots, exported JPEGs without EXIF, etc.).
 */
export async function parseImageExif(buffer: ArrayBuffer): Promise<ExtractedMetadata> {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await exifr.parse(buffer, {
      pick: ["DateTimeOriginal", "CreateDate", "ModifyDate", "Make", "Model"],
    });
  } catch (err) {
    return {
      ...EMPTY,
      extractionError: `exifr_parse: ${(err as Error).message ?? String(err)}`,
    };
  }

  if (!parsed) return { ...EMPTY };

  const dt =
    toIsoAndUnix(parsed.DateTimeOriginal) ??
    toIsoAndUnix(parsed.CreateDate);

  return {
    datetimeOriginal: dt?.iso ?? null,
    datetimeSource: dt ? "exif" : "none",
    capturedAtUnix: dt?.unix ?? null,
    make: nonEmpty(parsed.Make),
    model: nonEmpty(parsed.Model),
    durationSeconds: null,
    extractionError: null,
  };
}

// ---------------------------------------------------------------------------
// Pure parser: ffprobe JSON
// ---------------------------------------------------------------------------

interface FfprobeFormat {
  tags?: Record<string, unknown>;
  /** Container duration in seconds. Stringified float in ffprobe output. */
  duration?: string;
}
interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: Array<{ tags?: Record<string, unknown> }>;
}

/**
 * Parses ffprobe's `format_tags:stream_tags` JSON. Datetime priority:
 *   1. `com.apple.quicktime.creationdate`   (Apple iPhone capture, with TZ)
 *   2. `date`                                (generic capture date with TZ)
 *   3. `creation_time`                       (file mux time; least reliable —
 *                                             may be the re-encode timestamp
 *                                             rather than the original capture)
 *
 * Make/Model come from `make`/`model` or their `com.apple.quicktime.*`
 * variants. Unknown structure or missing tags return EMPTY.
 */
export function parseVideoFfprobeJson(json: string): ExtractedMetadata {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(json) as FfprobeOutput;
  } catch {
    return { ...EMPTY, extractionError: "ffprobe_invalid_json" };
  }

  const formatTags = parsed.format?.tags ?? {};
  const streamTags = parsed.streams?.[0]?.tags ?? {};
  const tags: Record<string, unknown> = { ...streamTags, ...formatTags };

  const dt =
    toIsoAndUnix(tags["com.apple.quicktime.creationdate"]) ??
    toIsoAndUnix(tags["date"]) ??
    toIsoAndUnix(tags["creation_time"]);

  const make =
    nonEmpty(tags["com.apple.quicktime.make"]) ??
    nonEmpty(tags["make"]);
  const model =
    nonEmpty(tags["com.apple.quicktime.model"]) ??
    nonEmpty(tags["model"]);

  // format.duration is a stringified float; treat 0 / negative / unparseable
  // as "no duration" so the join key naturally drops them.
  let duration: number | null = null;
  const durRaw = parsed.format?.duration;
  if (typeof durRaw === "string" && durRaw.length > 0) {
    const d = Number.parseFloat(durRaw);
    if (Number.isFinite(d) && d > 0) duration = d;
  }

  return {
    datetimeOriginal: dt?.iso ?? null,
    datetimeSource: dt ? "quicktime" : "none",
    capturedAtUnix: dt?.unix ?? null,
    make,
    model,
    durationSeconds: duration,
    extractionError: null,
  };
}

// ---------------------------------------------------------------------------
// I/O dispatcher
// ---------------------------------------------------------------------------

/**
 * Reads metadata from the given absolute path. Image bytes flow through the
 * disk-reads gateway; ffprobe spawn also goes through the gateway. Returns
 * an EMPTY-ish result with an `extractionError` set on hard failures so the
 * caller can persist the attempt and not retry.
 */
export async function extractFromPath(filePath: string, filename: string): Promise<ExtractedMetadata> {
  const kind = classifyByExtension(filename);

  if (kind === "image") {
    let buffer: ArrayBuffer;
    try {
      buffer = await readFileAll(filePath);
    } catch (err) {
      return {
        ...EMPTY,
        extractionError: `read_failed: ${(err as Error).message ?? String(err)}`,
      };
    }
    return parseImageExif(buffer);
  }


  if (kind === "video") {
    const json = await probeVideoMetadata(filePath);
    if (json === null) {
      return { ...EMPTY, extractionError: "ffprobe_failed" };
    }
    return parseVideoFfprobeJson(json);
  }

  // Unsupported extension — record the attempt with a stable marker so the
  // job's per-file loop can skip re-extraction in future runs.
  return { ...EMPTY, extractionError: "unsupported_extension" };
}
