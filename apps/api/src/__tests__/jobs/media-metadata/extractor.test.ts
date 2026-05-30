import { describe, it, expect } from "bun:test";
import {
  classifyByExtension,
  parseVideoFfprobeJson,
  parseImageExif,
  extractFromPath,
} from "../../../jobs/media-metadata/extractor";

describe("classifyByExtension", () => {
  it("recognises common image extensions case-insensitively", () => {
    for (const name of ["a.jpg", "B.JPEG", "c.PNG", "d.heic", "e.HEIF", "f.cr2", "g.dng"]) {
      expect(classifyByExtension(name)).toBe("image");
    }
  });

  it("recognises common video extensions case-insensitively", () => {
    for (const name of ["a.mp4", "B.MOV", "c.m4v", "d.WEBM", "e.mkv", "f.3gp"]) {
      expect(classifyByExtension(name)).toBe("video");
    }
  });

  it("returns 'unsupported' for sidecars, archives, and ambiguous names", () => {
    for (const name of ["foo.json", "bar.zip", "baz.txt", "noext", "trailing."]) {
      expect(classifyByExtension(name)).toBe("unsupported");
    }
  });
});

describe("parseVideoFfprobeJson — Apple QuickTime priority", () => {
  it("prefers com.apple.quicktime.creationdate over date over creation_time", () => {
    const out = parseVideoFfprobeJson(
      JSON.stringify({
        format: {
          tags: {
            "com.apple.quicktime.creationdate": "2019-03-04T05:06:07-0800",
            date: "2020-01-01T00:00:00Z",
            creation_time: "2021-01-01T00:00:00.000000Z",
            make: "Apple",
            model: "iPhone 11",
          },
        },
      })
    );

    expect(out.datetimeSource).toBe("quicktime");
    expect(out.datetimeOriginal).toBe(new Date("2019-03-04T05:06:07-0800").toISOString());
    expect(out.make).toBe("Apple");
    expect(out.model).toBe("iPhone 11");
    expect(out.extractionError).toBeNull();
  });

  it("falls through to `date` when Apple-specific tag is absent", () => {
    const out = parseVideoFfprobeJson(
      JSON.stringify({
        format: {
          tags: {
            date: "2019-12-23T14:33:14+0100",
            creation_time: "2020-07-02T19:57:09.000000Z",
            make: "Apple",
          },
        },
      })
    );

    expect(out.datetimeOriginal).toBe(new Date("2019-12-23T14:33:14+0100").toISOString());
    expect(out.datetimeSource).toBe("quicktime");
    expect(out.make).toBe("Apple");
    expect(out.model).toBeNull();
  });

  it("uses creation_time only as a last resort", () => {
    const out = parseVideoFfprobeJson(
      JSON.stringify({
        format: { tags: { creation_time: "2020-07-02T19:57:09.000000Z" } },
      })
    );
    expect(out.datetimeOriginal).toBe("2020-07-02T19:57:09.000Z");
    expect(out.datetimeSource).toBe("quicktime");
  });

  it("returns EMPTY when no recognised tags are present", () => {
    const out = parseVideoFfprobeJson(JSON.stringify({ format: { tags: { encoder: "Lavf52" } } }));
    expect(out.datetimeOriginal).toBeNull();
    expect(out.datetimeSource).toBe("none");
    expect(out.capturedAtUnix).toBeNull();
    expect(out.extractionError).toBeNull();
  });

  it("skips bogus 1970-epoch creation_time when nothing else is set — recorded as is", () => {
    // Some MP4s (e.g. transcodes) have creation_time = 1970-01-01T00:00:00Z.
    // We currently still take it; this test documents that and pins the
    // behaviour. A future filter could reject epoch-zero, but for now it's
    // the user's responsibility to discard 1970 timestamps at query time.
    const out = parseVideoFfprobeJson(
      JSON.stringify({
        format: { tags: { creation_time: "1970-01-01T00:00:00.000000Z" } },
      })
    );
    expect(out.datetimeOriginal).toBe("1970-01-01T00:00:00.000Z");
    expect(out.capturedAtUnix).toBe(0);
  });

  it("returns an extractionError on malformed JSON", () => {
    const out = parseVideoFfprobeJson("not json");
    expect(out.extractionError).toBe("ffprobe_invalid_json");
    expect(out.datetimeSource).toBe("none");
  });

  it("normalises empty Make/Model to null and trims whitespace", () => {
    const out = parseVideoFfprobeJson(
      JSON.stringify({
        format: {
          tags: {
            "com.apple.quicktime.creationdate": "2020-01-01T00:00:00Z",
            make: "  ",
            model: "  iPhone 12  ",
          },
        },
      })
    );
    expect(out.make).toBeNull();
    expect(out.model).toBe("iPhone 12");
  });
});

describe("parseImageExif", () => {
  it("returns EMPTY on a buffer with no recognisable image header", async () => {
    const out = await parseImageExif(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer);
    // exifr returns undefined for non-image input; we don't error, just empty.
    expect(out.datetimeOriginal).toBeNull();
    expect(out.datetimeSource).toBe("none");
    expect(out.make).toBeNull();
    expect(out.model).toBeNull();
    // The error field may be null or contain a parser message depending on
    // exifr's defensive behaviour. Both are acceptable; what matters is that
    // the function returned a well-formed result.
  });

  it("extracts DateTimeOriginal, Make, Model from a tiny synthetic JPG with EXIF", async () => {
    // Use exifr's writer ... wait, exifr doesn't write. Instead, we build a
    // minimal JPEG with an EXIF segment by hand. We construct the smallest
    // valid JPEG with an APP1 EXIF block declaring DateTimeOriginal, Make,
    // Model. This is the same shape that comes off a camera, just with no
    // image data.
    const buf = buildMinimalJpegWithExif({
      dateTimeOriginal: "2019:01:25 04:49:28",
      make: "TestCam",
      model: "TestModel 5000",
    });

    const out = await parseImageExif(buf);
    expect(out.make).toBe("TestCam");
    expect(out.model).toBe("TestModel 5000");
    expect(out.datetimeOriginal).toBe(new Date("2019-01-25T04:49:28Z").toISOString());
    expect(out.datetimeSource).toBe("exif");
    expect(out.capturedAtUnix).toBe(Math.floor(new Date("2019-01-25T04:49:28Z").getTime() / 1000));
  });
});

describe("extractFromPath", () => {
  it("returns unsupported_extension for non-media filenames without doing I/O", async () => {
    const out = await extractFromPath("/nowhere/foo.txt", "foo.txt");
    expect(out.extractionError).toBe("unsupported_extension");
    expect(out.datetimeOriginal).toBeNull();
  });

  it("returns ffprobe_failed for missing video files (no crash)", async () => {
    const out = await extractFromPath("/nonexistent-path/foo.mov", "foo.mov");
    expect(out.extractionError).toBe("ffprobe_failed");
    expect(out.datetimeSource).toBe("none");
  });

  it("returns read_failed for missing image files", async () => {
    const out = await extractFromPath("/nonexistent-path/foo.jpg", "foo.jpg");
    expect(out.extractionError).toContain("read_failed");
  });
});

// ---------------------------------------------------------------------------
// Test helper: build a minimal JPEG with an EXIF APP1 segment.
//
// Layout (big-endian everywhere except the TIFF block, which we mark
// little-endian via "II"):
//
//   SOI (FFD8)
//   APP1 (FFE1) length=...
//     "Exif\0\0"
//     TIFF header (II 2A 00, 0x08 little-endian)
//     IFD0 with 3 tags: Make (0x010F ascii), Model (0x0110 ascii),
//                       ExifIFD pointer (0x8769 LONG)
//     ExifSubIFD with 1 tag: DateTimeOriginal (0x9003 ascii)
//   EOI (FFD9)
//
// Layout assembled inline so a reader can verify offsets against any EXIF
// reference. Numeric offsets are commented where they matter.
// ---------------------------------------------------------------------------
function buildMinimalJpegWithExif(opts: {
  dateTimeOriginal: string;
  make: string;
  model: string;
}): ArrayBuffer {
  const enc = new TextEncoder();
  const dto = enc.encode(opts.dateTimeOriginal + "\0");   // ASCII NUL-terminated
  const make = enc.encode(opts.make + "\0");
  const model = enc.encode(opts.model + "\0");

  // Each IFD entry is 12 bytes: tag(2) + type(2) + count(4) + value/offset(4)
  // For ASCII strings <=4 bytes inline; >4 we use an offset. Our strings are
  // >4 so they live in a data area appended after the IFDs.
  //
  // TIFF area layout (offsets from the start of the TIFF header):
  //   0x00  TIFF header: II 2A 00, IFD0 offset = 0x08
  //   0x08  IFD0:   entry count (2 bytes) + 3 entries (36) + next-IFD (4 bytes) = 42 bytes
  //                 -> ends at 0x32
  //   0x32  ExifSubIFD: entry count (2) + 1 entry (12) + next-IFD (4) = 18 bytes
  //                 -> ends at 0x44
  //   0x44  data area: dto, make, model

  const subIfdOffset = 0x32;
  const dataAreaStart = 0x44;
  const dtoOffset    = dataAreaStart;
  const makeOffset   = dtoOffset + dto.length;
  const modelOffset  = makeOffset + make.length;

  const tiffSize     = modelOffset + model.length;

  const tiff = new Uint8Array(tiffSize);
  const tv = new DataView(tiff.buffer);

  // TIFF header (little-endian)
  tiff[0] = 0x49; tiff[1] = 0x49;             // "II"
  tv.setUint16(2, 0x002A, true);              // magic 42
  tv.setUint32(4, 0x00000008, true);          // IFD0 offset

  // IFD0 — 3 entries
  let p = 0x08;
  tv.setUint16(p, 3, true); p += 2;            // count

  // Make (tag 0x010F, type 2 ASCII, count, offset)
  tv.setUint16(p, 0x010F, true); p += 2;
  tv.setUint16(p, 2, true);       p += 2;
  tv.setUint32(p, make.length, true); p += 4;
  tv.setUint32(p, makeOffset, true);  p += 4;

  // Model (tag 0x0110)
  tv.setUint16(p, 0x0110, true); p += 2;
  tv.setUint16(p, 2, true);       p += 2;
  tv.setUint32(p, model.length, true); p += 4;
  tv.setUint32(p, modelOffset, true);  p += 4;

  // ExifIFD pointer (tag 0x8769, type 4 LONG, count 1, value = subIfdOffset)
  tv.setUint16(p, 0x8769, true); p += 2;
  tv.setUint16(p, 4, true);       p += 2;
  tv.setUint32(p, 1, true);        p += 4;
  tv.setUint32(p, subIfdOffset, true); p += 4;

  tv.setUint32(p, 0, true); p += 4;           // next IFD = 0

  // ExifSubIFD — 1 entry
  p = subIfdOffset;
  tv.setUint16(p, 1, true); p += 2;
  tv.setUint16(p, 0x9003, true); p += 2;       // DateTimeOriginal
  tv.setUint16(p, 2, true);       p += 2;       // ASCII
  tv.setUint32(p, dto.length, true); p += 4;
  tv.setUint32(p, dtoOffset, true);  p += 4;
  tv.setUint32(p, 0, true); p += 4;             // next IFD = 0

  // Data area
  tiff.set(dto,   dtoOffset);
  tiff.set(make,  makeOffset);
  tiff.set(model, modelOffset);

  // APP1 segment payload = "Exif\0\0" + tiff
  const app1Payload = new Uint8Array(6 + tiff.length);
  app1Payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);  // "Exif\0\0"
  app1Payload.set(tiff, 6);

  // JPEG: SOI + APP1 marker + 2-byte length + payload + EOI
  const app1Len = app1Payload.length + 2;  // length includes the length field itself
  const out = new Uint8Array(2 + 2 + 2 + app1Payload.length + 2);
  let o = 0;
  out[o++] = 0xFF; out[o++] = 0xD8;          // SOI
  out[o++] = 0xFF; out[o++] = 0xE1;          // APP1
  out[o++] = (app1Len >> 8) & 0xFF;
  out[o++] = app1Len & 0xFF;
  out.set(app1Payload, o); o += app1Payload.length;
  out[o++] = 0xFF; out[o++] = 0xD9;          // EOI

  return out.buffer;
}
