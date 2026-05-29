import { Hono } from "hono";
import path from "path";
import { getDb } from "../db/client";
import { getAllDisks } from "../disks/registry";
import {
  fileExists,
  readFileRangeStream,
  readFileStream,
  statFile,
} from "../fs/disk-reads";

// ---------------------------------------------------------------------------
// Read-only media streaming endpoint for the compare UI.
//
// GET /api/media?path=<absolute>      — full file or 206 partial response
// GET /api/media?path=<absolute>&download=1   — Content-Disposition: attachment
//
// Path safety: the requested path is normalised and must resolve under the
// mount_path of some currently-registered disk. This prevents arbitrary
// reads off the machine via this endpoint, while still allowing the user to
// stream any media file recorded by Waypoint scans.
// ---------------------------------------------------------------------------

export const mediaRouter = new Hono();

// Map common photo/video extensions to MIME types. The browser figures out
// playback from the type, so being explicit about HEIC / MOV / etc. matters.
// Unrecognised extensions fall through to application/octet-stream — that
// still works for the download fallback path.
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function pathIsUnderMount(absolutePath: string, mounts: string[]): boolean {
  for (const m of mounts) {
    if (m.length === 0) continue;
    // Strict prefix check requires the mount path to be followed by a `/`
    // (or to equal the path exactly). Without this, "/Volumes/Data" would
    // also match "/Volumes/Data_other/foo".
    if (absolutePath === m) return true;
    if (absolutePath.startsWith(m.endsWith("/") ? m : m + "/")) return true;
  }
  return false;
}

interface ParsedRange {
  start: number;
  endInclusive: number;
}

function parseRange(header: string | undefined, size: number): ParsedRange | "invalid" | null {
  if (!header) return null;
  // Only handle a single byte range; multi-range responses are uncommon for
  // <video> playback. Anything we don't recognise → 416.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return "invalid";
  const startStr = match[1];
  const endStr = match[2];
  let start: number;
  let endInclusive: number;
  if (startStr === "" && endStr === "") return "invalid";
  if (startStr === "") {
    // Suffix form: "bytes=-N" — last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    start = Math.max(0, size - n);
    endInclusive = size - 1;
  } else {
    start = Number(startStr);
    endInclusive = endStr === "" ? size - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(endInclusive)) return "invalid";
  if (start < 0 || endInclusive < start || start >= size) return "invalid";
  if (endInclusive >= size) endInclusive = size - 1;
  return { start, endInclusive };
}

mediaRouter.get("/", async (c) => {
  const rawPath = c.req.query("path");
  if (!rawPath) return c.json({ error: "path query parameter is required" }, 400);
  if (!rawPath.startsWith("/")) {
    return c.json({ error: "path must be absolute" }, 400);
  }

  // Normalise (collapses `..` and `.`) so a path that escapes its mount via
  // traversal segments is rejected by the mount-prefix check below.
  const requested = path.normalize(rawPath);

  const db = getDb();
  const disks = getAllDisks(db);
  const mounts = disks
    .map((d) => d.mount_path)
    .filter((m): m is string => typeof m === "string" && m.length > 1);
  if (!pathIsUnderMount(requested, mounts)) {
    return c.json({ error: "path is not under a registered disk mount" }, 403);
  }

  if (!(await fileExists(requested))) {
    return c.json({ error: "file not found" }, 404);
  }

  const stat = await statFile(requested);
  const size = stat.size;
  const contentType = mimeFor(requested);
  const filename = path.basename(requested);
  const download = c.req.query("download") === "1";

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
  };
  if (download) {
    // RFC 5987 filename* for unicode-safe filenames; also include a fallback.
    const safe = filename.replace(/["\\]/g, "_");
    headers["Content-Disposition"] =
      `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  } else {
    headers["Content-Disposition"] = `inline; filename="${filename.replace(/["\\]/g, "_")}"`;
  }

  const rangeHeader = c.req.header("Range");
  const parsed = parseRange(rangeHeader, size);

  if (parsed === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }

  if (parsed) {
    const { start, endInclusive } = parsed;
    const length = endInclusive - start + 1;
    return new Response(readFileRangeStream(requested, start, endInclusive), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${endInclusive}/${size}`,
        "Content-Length": String(length),
      },
    });
  }

  return new Response(readFileStream(requested), {
    status: 200,
    headers: {
      ...headers,
      "Content-Length": String(size),
    },
  });
});
