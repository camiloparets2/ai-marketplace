import { describe, it, expect } from "vitest";
import {
  detectFormat,
  validateImageBytes,
  MAX_FILE_SIZE_BYTES,
  JPEG_QUALITY,
} from "@/lib/image-validation";

// ─── Minimal magic-byte fixtures ─────────────────────────────────────────────
// We only need the first 12 bytes correct for format detection.
// The rest of the buffer is zeroed padding.

function makeJpeg(extraBytes = 0): Uint8Array {
  const buf = new Uint8Array(12 + extraBytes);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

function makePng(extraBytes = 0): Uint8Array {
  const buf = new Uint8Array(12 + extraBytes);
  buf[0] = 0x89;
  buf[1] = 0x50; // P
  buf[2] = 0x4e; // N
  buf[3] = 0x47; // G
  return buf;
}

function makeWebp(extraBytes = 0): Uint8Array {
  const buf = new Uint8Array(12 + extraBytes);
  // RIFF
  buf[0] = 0x52;
  buf[1] = 0x49;
  buf[2] = 0x46;
  buf[3] = 0x46;
  // 4 bytes file size (ignored for detection)
  // WEBP
  buf[8] = 0x57;
  buf[9] = 0x45;
  buf[10] = 0x42;
  buf[11] = 0x50;
  return buf;
}

function makeHeic(extraBytes = 0): Uint8Array {
  const buf = new Uint8Array(12 + extraBytes);
  // bytes 0-3: box size (arbitrary)
  buf[0] = 0x00;
  buf[1] = 0x00;
  buf[2] = 0x00;
  buf[3] = 0x18;
  // bytes 4-7: "ftyp"
  buf[4] = 0x66; // f
  buf[5] = 0x74; // t
  buf[6] = 0x79; // y
  buf[7] = 0x70; // p
  // bytes 8-11: brand "heic"
  buf[8] = 0x68; // h
  buf[9] = 0x65; // e
  buf[10] = 0x69; // i
  buf[11] = 0x63; // c
  return buf;
}

function makeUnknown(): Uint8Array {
  // Starts with bytes that match none of the known formats
  return new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
}

// ─── detectFormat ─────────────────────────────────────────────────────────────

describe("detectFormat", () => {
  it("detects JPEG from FF D8 FF magic bytes", () => {
    expect(detectFormat(makeJpeg())).toBe("jpeg");
  });

  it("detects PNG from 89 50 4E 47 magic bytes", () => {
    expect(detectFormat(makePng())).toBe("png");
  });

  it("detects WebP from RIFF....WEBP magic bytes", () => {
    expect(detectFormat(makeWebp())).toBe("webp");
  });

  it("detects HEIC from ftyp at offset 4", () => {
    expect(detectFormat(makeHeic())).toBe("heic");
  });

  it("returns null for unrecognised bytes", () => {
    expect(detectFormat(makeUnknown())).toBeNull();
  });

  it("returns null for a buffer shorter than 12 bytes", () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

// ─── validateImageBytes ───────────────────────────────────────────────────────

describe("validateImageBytes", () => {
  it("accepts a valid JPEG under the size limit", () => {
    const result = validateImageBytes(makeJpeg());
    expect(result.valid).toBe(true);
    expect(result.format).toBe("jpeg");
    expect(result.isHeic).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("accepts a valid PNG under the size limit", () => {
    const result = validateImageBytes(makePng());
    expect(result.valid).toBe(true);
    expect(result.format).toBe("png");
  });

  it("accepts a valid WebP under the size limit", () => {
    const result = validateImageBytes(makeWebp());
    expect(result.valid).toBe(true);
    expect(result.format).toBe("webp");
  });

  it("rejects HEIC with a conversion-required error", () => {
    const result = validateImageBytes(makeHeic());
    expect(result.valid).toBe(false);
    expect(result.isHeic).toBe(true);
    expect(result.error).toMatch(/HEIC/i);
    expect(result.error).toMatch(/convert/i);
  });

  it("rejects an unrecognised format with a clear error", () => {
    const result = validateImageBytes(makeUnknown());
    expect(result.valid).toBe(false);
    expect(result.format).toBeNull();
    expect(result.error).toMatch(/unsupported/i);
    expect(result.error).toMatch(/JPEG|PNG|WebP/);
  });

  it("rejects a file exactly at the 5 MB limit + 1 byte", () => {
    // Create a minimal JPEG header followed by enough padding to exceed 5 MB
    const oversized = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[2] = 0xff;

    const result = validateImageBytes(oversized);
    expect(result.valid).toBe(false);
    expect(result.sizeBytes).toBe(MAX_FILE_SIZE_BYTES + 1);
    expect(result.error).toMatch(/too large/i);
    expect(result.error).toMatch(/5/); // mentions 5 MB
  });

  it("accepts a file exactly at the 5 MB limit", () => {
    const atLimit = new Uint8Array(MAX_FILE_SIZE_BYTES);
    atLimit[0] = 0xff;
    atLimit[1] = 0xd8;
    atLimit[2] = 0xff;

    const result = validateImageBytes(atLimit);
    expect(result.valid).toBe(true);
  });

  it("reports the correct sizeBytes on the result", () => {
    const buf = makeJpeg(100);
    const result = validateImageBytes(buf);
    expect(result.sizeBytes).toBe(buf.length);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("JPEG_QUALITY constant", () => {
  it("is 0.85 — changing this breaks OCR accuracy for barcode/label text", () => {
    // This test exists to prevent accidental lowering of quality below the
    // OCR-safe threshold. See image-validation.ts comment for reasoning.
    expect(JPEG_QUALITY).toBe(0.85);
  });
});
