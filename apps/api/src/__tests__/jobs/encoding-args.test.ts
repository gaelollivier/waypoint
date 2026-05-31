import { describe, it, expect } from "bun:test";
import { buildVariantArgs } from "../../jobs/encoding/encoding-args";

describe("buildVariantArgs", () => {
  it("emits libx265 video args with preset, crf, and hvc1 tag", () => {
    const r = buildVariantArgs({
      codec: "hevc",
      encoder: "libx265",
      preset: "slow",
      crf: 26,
    });
    expect(r.videoArgs).toEqual(["-c:v", "libx265", "-preset", "slow", "-crf", "26"]);
    expect(r.containerArgs).toEqual(["-c:a", "copy", "-tag:v", "hvc1"]);
    expect(r.extension).toBe("mp4");
  });

  it("uses -q:v for hevc_videotoolbox", () => {
    const r = buildVariantArgs({
      codec: "hevc",
      encoder: "hevc_videotoolbox",
      preset: null,
      crf: 55,
    });
    expect(r.videoArgs).toEqual(["-c:v", "hevc_videotoolbox", "-q:v", "55"]);
    expect(r.containerArgs).toContain("hvc1");
  });

  it("emits libsvtav1 with preset and crf, no hvc1 tag", () => {
    const r = buildVariantArgs({
      codec: "av1",
      encoder: "libsvtav1",
      preset: "6",
      crf: 32,
    });
    expect(r.videoArgs).toEqual(["-c:v", "libsvtav1", "-preset", "6", "-crf", "32"]);
    expect(r.containerArgs).not.toContain("hvc1");
  });

  it("libaom-av1 uses cpu-used for preset and -b:v 0 for CRF mode", () => {
    const r = buildVariantArgs({
      codec: "av1",
      encoder: "libaom-av1",
      preset: "4",
      crf: 30,
    });
    expect(r.videoArgs).toEqual([
      "-c:v",
      "libaom-av1",
      "-crf",
      "30",
      "-b:v",
      "0",
      "-cpu-used",
      "4",
    ]);
  });

  it("appends extraArgs verbatim", () => {
    const r = buildVariantArgs({
      codec: "hevc",
      encoder: "libx265",
      preset: "medium",
      crf: 22,
      extraArgs: ["-pix_fmt", "yuv420p10le"],
    });
    expect(r.videoArgs).toEqual([
      "-c:v",
      "libx265",
      "-preset",
      "medium",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p10le",
    ]);
  });

  it("throws on unknown encoder", () => {
    expect(() =>
      buildVariantArgs({ codec: "hevc", encoder: "nope", preset: null, crf: null })
    ).toThrow(/Unknown encoder/);
  });

  it("emits -c:v copy for the 'copy' pass-through encoder", () => {
    const r = buildVariantArgs({ codec: "reference", encoder: "copy", preset: null, crf: null });
    expect(r.videoArgs).toEqual(["-c:v", "copy"]);
  });
});
