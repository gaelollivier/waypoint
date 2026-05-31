/**
 * Maps an encoding_variants row to ffmpeg arguments + container choice.
 *
 * Each encoder gets a small switch arm with its native quality knob:
 *   - libx265 / libsvtav1 / libaom-av1 use -crf
 *   - hevc_videotoolbox uses -q:v
 *   - copy passes through (used for the reference/source variant)
 *
 * The container default is mp4 with the appropriate `-tag:v` so QuickTime
 * and iOS Photos play the result without re-muxing.
 */

export interface VariantArgsInput {
  codec: string;
  encoder: string;
  preset: string | null;
  crf: number | null;
  extraArgs?: string[];
}

export interface VariantArgsResult {
  videoArgs: string[];
  containerArgs: string[];
  extension: string;
}

export function buildVariantArgs(v: VariantArgsInput): VariantArgsResult {
  const videoArgs: string[] = [];
  const containerArgs: string[] = ["-c:a", "copy"];
  let extension = "mp4";

  switch (v.encoder) {
    case "libx265": {
      videoArgs.push("-c:v", "libx265");
      if (v.preset) videoArgs.push("-preset", v.preset);
      if (v.crf !== null) videoArgs.push("-crf", String(v.crf));
      containerArgs.push("-tag:v", "hvc1");
      break;
    }
    case "hevc_videotoolbox": {
      videoArgs.push("-c:v", "hevc_videotoolbox");
      // VideoToolbox uses -q:v (1–100). Map CRF-style numbers directly.
      if (v.crf !== null) videoArgs.push("-q:v", String(v.crf));
      containerArgs.push("-tag:v", "hvc1");
      break;
    }
    case "libsvtav1": {
      videoArgs.push("-c:v", "libsvtav1");
      // libsvtav1's "preset" is an integer 0–13 (lower = slower/better).
      if (v.preset) videoArgs.push("-preset", v.preset);
      if (v.crf !== null) videoArgs.push("-crf", String(v.crf));
      break;
    }
    case "libaom-av1": {
      videoArgs.push("-c:v", "libaom-av1");
      if (v.crf !== null) videoArgs.push("-crf", String(v.crf), "-b:v", "0");
      // libaom uses -cpu-used (0 = slowest, 8 = fastest).
      if (v.preset) videoArgs.push("-cpu-used", v.preset);
      break;
    }
    case "librav1e": {
      videoArgs.push("-c:v", "librav1e");
      if (v.crf !== null) videoArgs.push("-qp", String(v.crf));
      if (v.preset) videoArgs.push("-speed", v.preset);
      break;
    }
    case "libx264": {
      videoArgs.push("-c:v", "libx264");
      if (v.preset) videoArgs.push("-preset", v.preset);
      if (v.crf !== null) videoArgs.push("-crf", String(v.crf));
      break;
    }
    case "copy": {
      videoArgs.push("-c:v", "copy");
      // Container stays mp4 by default; let the caller override via extraArgs.
      break;
    }
    default:
      throw new Error(`Unknown encoder: ${v.encoder}`);
  }

  if (v.extraArgs && v.extraArgs.length > 0) {
    videoArgs.push(...v.extraArgs);
  }
  return { videoArgs, containerArgs, extension };
}
