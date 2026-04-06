// Route segment config — sets the Vercel serverless function timeout for App Router.
// Claude Vision calls can take 15-20s on complex images; 60s gives safe headroom.
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import Anthropic, {
  APIConnectionTimeoutError,
  RateLimitError,
  APIError,
} from "@anthropic-ai/sdk";
import { createServerClient } from "@supabase/ssr";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { validateImageBytes } from "@/lib/image-validation";
import { EXTRACTION_TOOL_SCHEMA } from "@/lib/types/extraction";
import type { ExtractionResult } from "@/lib/types/extraction";
import type { AcceptedMimeType } from "@/lib/image-validation";
import { getShippingRate } from "@/lib/shipping";
import { supabaseAdmin } from "@/lib/supabase";

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// 5 scans per IP per 24-hour fixed window.
// Lazily initialised — avoids import-time crash if env vars are missing in
// local dev before .env.local is configured.
let _ratelimit: Ratelimit | null = null;
function getRatelimit(): Ratelimit {
  if (!_ratelimit) {
    _ratelimit = new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      limiter: Ratelimit.fixedWindow(5, "24 h"),
      // Prefix keeps our keys isolated from any other data in the same DB.
      prefix: "snap2list:rl",
    });
  }
  return _ratelimit;
}

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
  // ── Auth — Supabase session (Phase 2) ───────────────────────────────────────
  // Creates a Supabase client directly from the request cookies so the route
  // handler can validate the JWT without touching next/headers (which is
  // Server-Component-only). getUser() validates with Supabase's servers —
  // safer than getSession() which only reads the local cookie.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: () => {}, // Route handlers can't write cookies back onto the request
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse("Unauthorized", false, 401);
  }

  // ── Rate limiting — per authenticated user ──────────────────────────────────
  // Keyed on user.id (UUID) instead of IP: no VPN bypass, no shared-NAT false
  // positives. 5 scans per user per 24-hour fixed window.
  // Skipped gracefully when Upstash env vars are absent (local dev / CI).
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { success } = await getRatelimit().limit(user.id);
      if (!success) {
        return errorResponse(
          "You have reached your daily limit of 5 scans. Please try again tomorrow.",
          false,
          429
        );
      }
    } catch (rlErr) {
      // Rate limiter outage → fail open so sellers aren't blocked.
      // Log so we can alert on Upstash issues without interrupting the workflow.
      console.error("[analyze] Rate limiter error — failing open", rlErr);
    }
  } else {
    console.warn("[analyze] Upstash env vars not set — rate limiting skipped");
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  // Phase 3: accepts { images: [{data, mimeType}], condition }
  let imageEntries: Array<{ data: string; mimeType: AcceptedMimeType }>;
  let userCondition: string;

  try {
    const body = (await req.json()) as {
      images?: unknown;
      condition?: unknown;
    };

    if (
      !Array.isArray(body.images) ||
      body.images.length === 0 ||
      body.images.length > 5
    ) {
      return errorResponse("Provide 1 to 5 images", false, 400);
    }

    const validConditions = ["New", "Like New", "Good", "Fair", "Poor"];
    userCondition =
      typeof body.condition === "string" &&
      validConditions.includes(body.condition)
        ? body.condition
        : "Good";

    imageEntries = [];
    for (const img of body.images) {
      const entry = img as { data?: unknown; mimeType?: unknown };
      if (typeof entry.data !== "string" || !entry.data) {
        return errorResponse("Missing image data in array", false, 400);
      }
      if (
        entry.mimeType !== "image/jpeg" &&
        entry.mimeType !== "image/png" &&
        entry.mimeType !== "image/webp"
      ) {
        return errorResponse(
          "Each image mimeType must be image/jpeg, image/png, or image/webp",
          false,
          400
        );
      }
      imageEntries.push({
        data: entry.data,
        mimeType: entry.mimeType,
      });
    }
  } catch {
    return errorResponse("Invalid JSON body", false, 400);
  }

  // ── Server-side image validation ────────────────────────────────────────────
  const imageBlocks: Array<{
    type: "image";
    source: { type: "base64"; media_type: AcceptedMimeType; data: string };
  }> = [];

  for (const entry of imageEntries) {
    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(entry.data, "base64");
    } catch {
      return errorResponse("Image data is not valid base64", false, 400);
    }

    const validation = validateImageBytes(new Uint8Array(imageBuffer));
    if (!validation.valid) {
      return errorResponse(
        validation.error ?? "Invalid image",
        false,
        400
      );
    }

    imageBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: entry.mimeType,
        data: entry.data,
      },
    });
  }

  // ── Claude Vision call ──────────────────────────────────────────────────────
  // tool_choice forces Claude to always call extract_listing and return
  // structured JSON matching ExtractionResult. No free-text parsing needed.
  try {
    const response = await getClient().messages.create(
      {
        model: process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6",
        max_tokens: 1200,
        tools: [EXTRACTION_TOOL_SCHEMA as unknown as Anthropic.Tool],
        tool_choice: { type: "tool", name: "extract_listing" },
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              {
                type: "text",
                text: [
                  `The user has manually identified this item as "${userCondition}".`,
                  `Weight this heavily in your pricing research.`,
                  userCondition === "New"
                    ? "Since the item is New, focus on MSRP and new-in-box resale pricing."
                    : `Since the item is "${userCondition}", lower the estimate accordingly and look for flaws across all provided images.`,
                  imageBlocks.length > 1
                    ? `Analyze all ${imageBlocks.length} product photos together and extract structured listing data.`
                    : "Analyze this product photo and extract all structured listing data.",
                  "Look carefully at labels, barcodes, text, and physical characteristics across all images.",
                  "For dimensions and weight, use visual cues and reference objects if visible.",
                  "Be precise about model numbers, UPCs, and technical specifications —",
                  "accuracy prevents buyer returns on high-ticket items.",
                  "Set confidence scores honestly: 90+ only when you can read the value directly",
                  "from the photo; 50-70 for reasonable inference; below 50 when uncertain.",
                  `For suggestedPrice: factor in the "${userCondition}" condition.`,
                  "Use your knowledge of current resale market values on eBay,",
                  "Facebook Marketplace, and similar platforms for this exact item in this condition.",
                  "Price to sell within 1–2 weeks — competitive but not a fire sale.",
                  "In priceRationale, cite the comparable market range and explain your number in 1–2 sentences.",
                ].join(" "),
              },
            ],
          },
        ],
      },
      {
        // 45-second timeout. Multi-image vision calls can take longer.
        timeout: 45_000,
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

    // Use the seller's explicit condition — not Claude's visual guess.
    extracted.condition =
      userCondition as ExtractionResult["condition"];

    // ── Persist to Supabase ───────────────────────────────────────────────────
    // Fire-and-forget with a try/catch: a DB failure must never break the user's
    // workflow. The extraction result is returned regardless.
    try {
      const { error: dbError } = await supabaseAdmin
        .from("listings_log")
        .insert({
          seller_id: user.id,
          title: extracted.title,
          brand: extracted.brand,
          model: extracted.model,
          upc: extracted.upc,
          condition: userCondition,
          category: extracted.category,
          suggested_price: extracted.suggestedPrice,
          price_rationale: extracted.priceRationale,
          suggested_shipping_service: extracted.suggestedShippingService,
          raw_specs: extracted.specs,
          raw_dimensions: extracted.estimatedDimensions,
        });

      if (dbError) {
        // Log but do not surface to the user.
        console.error("[analyze] Supabase insert failed", dbError);
      }
    } catch (dbErr) {
      console.error("[analyze] Supabase insert threw unexpectedly", dbErr);
    }

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
