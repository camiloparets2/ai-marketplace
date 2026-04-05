// ─── Constants ────────────────────────────────────────────────────────────────

// 5MB post-compression ceiling. Base64 encoding adds ~33%, so the raw file
// sent to the API will be up to ~6.7MB — within Next.js default body limits.
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

// 0.85 preserves label legibility for barcode / model-number OCR without
// producing unnecessarily large payloads. Do NOT lower below 0.80 — JPEG
// artifacts at that level degrade text recognition on fine-print labels.
export const JPEG_QUALITY = 0.85;

// Longest edge after rescaling. Keeps Claude's input token count predictable
// while retaining enough resolution for spec text and barcode OCR.
export const MAX_DIMENSION_PX = 2048;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImageFormat = "jpeg" | "png" | "webp" | "heic";
export type AcceptedMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ValidationResult {
  valid: boolean;
  format: ImageFormat | null;
  sizeBytes: number;
  isHeic: boolean;
  // User-facing error string, present when valid === false.
  error?: string;
}

// ─── Format detection (Node-compatible) ──────────────────────────────────────

// Detect image format from magic bytes. More reliable than file extension or
// MIME type since both can be spoofed or wrong (e.g. iOS photos saved as .jpg
// but encoded as HEIC).
export function detectFormat(buffer: Uint8Array): ImageFormat | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  // WebP: RIFF????WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }

  // HEIC: ISO Base Media File Format box — "ftyp" at byte offset 4.
  // Covers heic, heis, heim, heix, hevc, hevx, mif1, msf1 brand variants.
  // iPhone HEIC photos always follow this structure.
  if (
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return "heic";
  }

  return null;
}

// ─── Validation (Node-compatible) ─────────────────────────────────────────────

// Validate raw image bytes. Called server-side in /api/analyze after base64
// decoding to verify the client sent a real, accepted image before hitting
// the Anthropic API.
export function validateImageBytes(buffer: Uint8Array): ValidationResult {
  const sizeBytes = buffer.length;
  const format = detectFormat(buffer);
  const isHeic = format === "heic";

  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      format,
      sizeBytes,
      isHeic,
      error: `Image is too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Please use a photo under 5 MB.`,
    };
  }

  if (format === null) {
    return {
      valid: false,
      format: null,
      sizeBytes,
      isHeic: false,
      error:
        "Unsupported image format. Please use a JPEG, PNG, or WebP photo.",
    };
  }

  if (isHeic) {
    // HEIC should be converted client-side before upload. If we see it here,
    // the client-side conversion was skipped or failed.
    return {
      valid: false,
      format: "heic",
      sizeBytes,
      isHeic: true,
      error:
        "HEIC images must be converted before upload. Please try again or use a JPEG photo.",
    };
  }

  return { valid: true, format, sizeBytes, isHeic: false };
}

// ─── Browser-only: HEIC conversion ────────────────────────────────────────────
// These functions use browser APIs (Canvas, heic2any) and must not be imported
// in Node.js contexts (server components, API routes, tests).

// Convert an HEIC file to JPEG using heic2any. Dynamically imported so the
// module doesn't crash in SSR or test environments.
export async function convertHeicToJpeg(file: File): Promise<File> {
  const heic2any = (await import("heic2any")).default;
  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: JPEG_QUALITY,
  });
  // heic2any returns Blob | Blob[] — take the first blob if it's an array
  const blob = Array.isArray(result) ? result[0] : result;
  return new File([blob], file.name.replace(/\.heic$/i, ".jpg"), {
    type: "image/jpeg",
  });
}

// Resize and compress a Blob using Canvas API.
// Downscales to MAX_DIMENSION_PX on the longest edge, encodes as JPEG at
// JPEG_QUALITY (0.85) to keep barcode and label text legible for OCR.
export async function compressImage(
  blob: Blob,
  outputMime: AcceptedMimeType = "image/jpeg"
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      if (Math.max(width, height) > MAX_DIMENSION_PX) {
        if (width >= height) {
          height = Math.round((height * MAX_DIMENSION_PX) / width);
          width = MAX_DIMENSION_PX;
        } else {
          width = Math.round((width * MAX_DIMENSION_PX) / height);
          height = MAX_DIMENSION_PX;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas context unavailable"));
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (compressed) => {
          if (!compressed) return reject(new Error("Canvas toBlob failed"));
          resolve(compressed);
        },
        outputMime,
        // Quality only applies to lossy formats (jpeg/webp). PNG ignores it.
        JPEG_QUALITY
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image for compression"));
    };

    img.src = url;
  });
}

// Full client-side pipeline: HEIC conversion → compression → format + size check.
// Returns the processed Blob ready for base64 encoding and upload to /api/analyze.
export async function prepareImageForUpload(file: File): Promise<{
  blob: Blob;
  mimeType: AcceptedMimeType;
  error?: string;
}> {
  let workingBlob: Blob = file;
  let mimeType: AcceptedMimeType = "image/jpeg";

  // Detect format from the first bytes (more reliable than file.type)
  const headerBytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const format = detectFormat(headerBytes);

  if (format === null) {
    return {
      blob: file,
      mimeType,
      error: "Unsupported image format. Please use a JPEG, PNG, or WebP photo.",
    };
  }

  // Convert HEIC → JPEG first, then compress
  if (format === "heic") {
    try {
      workingBlob = await convertHeicToJpeg(file);
      mimeType = "image/jpeg";
    } catch {
      return {
        blob: file,
        mimeType,
        error:
          "Could not convert this photo. Please try a JPEG or PNG instead.",
      };
    }
  } else {
    mimeType =
      format === "png"
        ? "image/png"
        : format === "webp"
          ? "image/webp"
          : "image/jpeg";
  }

  // Compress: resize + re-encode
  try {
    workingBlob = await compressImage(workingBlob, mimeType);
  } catch {
    // Compression failure is non-fatal — fall through with original blob
  }

  if (workingBlob.size > MAX_FILE_SIZE_BYTES) {
    return {
      blob: workingBlob,
      mimeType,
      error: `Photo is still too large after compression (${(workingBlob.size / 1024 / 1024).toFixed(1)} MB). Please try a different photo.`,
    };
  }

  return { blob: workingBlob, mimeType };
}
