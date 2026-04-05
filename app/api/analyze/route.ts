import { NextRequest, NextResponse } from "next/server";
import Anthropic, {
  APIConnectionTimeoutError,
  RateLimitError,
  APIError,
} from "@anthropic-ai/sdk";
import { validateImageBytes } from "@/lib/image-validation";
import { EXTRACTION_TOOL_SCHEMA } from "@/lib/types/extraction";
import type { ExtractionResult } from "@/lib/types/extraction";
import type { AcceptedMimeType } from "@/lib/image-validation";
import { getShippingRate } from "@/lib/shipping";

// Lazily initialised — avoids import-time crash when ANTHROPIC_API_KEY is absent
// in local dev before .env.local is configured.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

// ─── Error shape ──────────────────────────────────────────────────────────────

// All errors from this route follow this shape so the frontend can render a
// consistent "Try a different photo" CTA without inspecting status codes.
interface AnalyzeError {
  error: string;
  // true → user can retry the same photo; false → must pick a new photo
  retryable: boolean;
}

function errorResponse(
  message: string,
  retryable: boolean,
  status: number
): NextResponse<AnalyzeError> {
  return NextResponse.json({ error: message, retryable }, { status });
}

// ─── Route ────────────────────────────────────────────────────────────────────

// Expected request body:
//   { image: string (base64), mimeType: AcceptedMimeType }
//
// Image must be pre-processed client-side:
//   1. HEIC → JPEG conversion via heic2any
//   2. Resize to max 2048px on longest edge
//   3. JPEG re-encode at quality 0.85  ← see lib/image-validation.ts JPEG_QUALITY
//
// The server re-validates the decoded bytes before forwarding to Anthropic so
// a buggy client can never trigger an expensive API call with bad data.

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  // Phase 1: simple pre-shared API key shared with the 10 test sellers.
  // Phase 2: replace with Upstash Redis per-IP rate limiting when the URL
  // becomes semi-public. See TODOS.md.
  const incomingKey = req.headers.get("x-api-key");
  if (
    !process.env.APP_INTERNAL_BETA_KEY ||
    incomingKey !== process.env.APP_INTERNAL_BETA_KEY
  ) {
    return errorResponse("Unauthorized", false, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let imageBase64: string;
  let mimeType: AcceptedMimeType;

  try {
    const body = (await req.json()) as {
      image?: unknown;
      mimeType?: unknown;
    };

    if (typeof body.image !== "string" || !body.image) {
      return errorResponse("Missing image field", false, 400);
    }
    if (
      body.mimeType !== "image/jpeg" &&
      body.mimeType !== "image/png" &&
      body.mimeType !== "image/webp"
    ) {
      return errorResponse(
        "mimeType must be image/jpeg, image/png, or image/webp",
        false,
        400
      );
    }

    imageBase64 = body.image;
    mimeType = body.mimeType;
  } catch {
    return errorResponse("Invalid JSON body", false, 400);
  }

  // ── Server-side image validation ────────────────────────────────────────────
  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(imageBase64, "base64");
  } catch {
    return errorResponse("Image data is not valid base64", false, 400);
  }

  const validation = validateImageBytes(new Uint8Array(imageBuffer));
  if (!validation.valid) {
    // Validation errors are not retryable with the same photo — user must fix
    return errorResponse(
      validation.error ?? "Invalid image",
      false,
      400
    );
  }

  // ── Claude Vision call ──────────────────────────────────────────────────────
  // tool_choice forces Claude to always call extract_listing and return
  // structured JSON matching ExtractionResult. No free-text parsing needed.
  try {
    const response = await getClient().messages.create(
      {
        model: process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6",
        max_tokens: 1024,
        tools: [EXTRACTION_TOOL_SCHEMA as unknown as Anthropic.Tool],
        tool_choice: { type: "tool", name: "extract_listing" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: imageBase64,
                },
              },
              {
                type: "text",
                text: [
                  "Analyze this product photo and extract all structured listing data.",
                  "Look carefully at labels, barcodes, text, and physical characteristics.",
                  "For dimensions and weight, use visual cues and reference objects if visible.",
                  "Be precise about model numbers, UPCs, and technical specifications —",
                  "accuracy prevents buyer returns on high-ticket items.",
                  "Set confidence scores honestly: 90+ only when you can read the value directly",
                  "from the photo; 50-70 for reasonable inference; below 50 when uncertain.",
                ].join(" "),
              },
            ],
          },
        ],
      },
      {
        // 30-second wall-clock timeout. Vision calls on complex images can
        // occasionally take 15-20s; 30s gives headroom without hanging the UI.
        timeout: 30_000,
      }
    );

    // tool_choice: { type: 'tool' } guarantees a tool_use block in the response.
    // Defensive check in case of an unexpected API change.
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      console.error(
        "[analyze] Unexpected response shape — no tool_use block",
        response.content
      );
      return errorResponse(
        "Analysis returned an unexpected response. Please try again.",
        true,
        500
      );
    }

    const extracted = toolBlock.input as ExtractionResult;

    // Overwrite Claude's shipping cost with the authoritative lookup table value.
    // We trust our table, not Claude's price number — rates change and Claude
    // may hallucinate costs.
    const shippingRate = getShippingRate(extracted.suggestedShippingService);
    extracted.estimatedShippingCost = shippingRate.cost;

    return NextResponse.json(extracted);
  } catch (err) {
    // ── Anthropic SDK error handling ──────────────────────────────────────────
    if (err instanceof RateLimitError) {
      return errorResponse(
        "Service is busy right now. Please wait a moment and try again.",
        true,
        429
      );
    }

    if (err instanceof APIConnectionTimeoutError) {
      return errorResponse(
        "Analysis timed out. Please try again — complex photos sometimes take longer.",
        true,
        504
      );
    }

    if (err instanceof APIError) {
      // Covers InternalServerError and other 5xx from Anthropic
      console.error("[analyze] Anthropic API error", err.status, err.message);
      return errorResponse(
        "Analysis failed. Please try a different photo or try again shortly.",
        true,
        502
      );
    }

    // Unknown error — log and return generic message
    console.error("[analyze] Unexpected error", err);
    return errorResponse(
      "Something went wrong. Please try again.",
      true,
      500
    );
  }
}
