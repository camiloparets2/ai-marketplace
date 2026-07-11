// Route segment config — sets the Vercel serverless function timeout for App Router.
// Claude Vision calls can take 15-20s on complex images; 60s gives safe headroom.
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { validateImageBytes } from "@/lib/image-validation";
import { identifyItem, VisionError } from "@/lib/ai/vision";
import type { AcceptedMimeType } from "@/lib/image-validation";
import { getShippingRate } from "@/lib/shipping";
import { requireUser } from "@/lib/auth/guard";
import { randomUUID } from "crypto";
import { spendCredits, refundCredits } from "@/lib/billing/credits";
import { CREDIT_COST_AI_EXTRACTION } from "@/lib/billing/plans";
import { checkRateLimit, requestIdentity, RATE_RULES } from "@/lib/rate-limit";
import { trackEvent } from "@/lib/telemetry";

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
  // A real session is required so AI usage is always metered to one account.
  const user = await requireUser();
  if (!user) {
    return errorResponse("Unauthorized", false, 401);
  }
  const userId = user.id;

  // Abuse protection ahead of the expensive Claude call (credits already gate
  // signed-in volume; this blunts scripted bursts and beta-key abuse).
  const allowed = await checkRateLimit(
    RATE_RULES.analyze,
    requestIdentity(req, userId)
  );
  if (!allowed) {
    return errorResponse(
      "Too many photos too fast — please wait a bit and try again.",
      true,
      429
    );
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

  // ── AI credits ──────────────────────────────────────────────────────────────
  // 1 credit per extraction, reserved atomically BEFORE the (expensive) API
  // call and refunded if the call fails to produce a usable draft. Legacy
  // beta-key requests carry no user, so they aren't metered (Gate 2 TODO).
  const requestId = randomUUID();
  let credited = false;
  const spend = await spendCredits(
    userId,
    CREDIT_COST_AI_EXTRACTION,
    "ai_listing_extraction",
    requestId
  );
  if (!spend.ok) {
    if (spend.reason === "no_credits") {
      const renews = spend.status.periodEnd
        ? ` Your credits renew ${new Date(spend.status.periodEnd).toLocaleDateString()}.`
        : "";
      return NextResponse.json(
        {
          error: `You're out of AI credits.${renews} Upgrade your plan to keep listing.`,
          retryable: false,
          code: "no_credits",
          renewsAt: spend.status.periodEnd,
        },
        { status: 402 }
      );
    }
    return errorResponse(
      "Credit service is temporarily unavailable. Please try again shortly.",
      true,
      503
    );
  }
  credited = true;

  // Refund helper for every failure path below the spend.
  async function refund(): Promise<void> {
    if (credited) {
      await refundCredits(userId, CREDIT_COST_AI_EXTRACTION, requestId);
    }
  }

  // ── Claude Vision call ──────────────────────────────────────────────────────
  // All Vision work lives in lib/ai/vision.ts (CLAUDE.md rule). Every failure
  // path refunds the credit first.
  try {
    const identified = await identifyItem(imageBase64, mimeType);
    const extracted = identified.extraction;

    // Overwrite Claude's shipping cost with the authoritative lookup table value.
    // We trust our table, not Claude's price number — rates change and Claude
    // may hallucinate costs.
    const shippingRate = getShippingRate(extracted.suggestedShippingService);
    extracted.estimatedShippingCost = shippingRate.cost;

    await trackEvent(userId, "draft_created", { requestId });
    return NextResponse.json(extracted);
  } catch (err) {
    await refund();
    await trackEvent(userId, "draft_failed", { requestId });

    if (err instanceof VisionError) {
      const status =
        err.kind === "rate_limited"
          ? 429
          : err.kind === "timeout"
            ? 504
            : err.kind === "api_error"
              ? 502
              : 500;
      return errorResponse(err.message, err.retryable, status);
    }

    console.error("[analyze] Unexpected error", err);
    return errorResponse("Something went wrong. Please try again.", true, 500);
  }
}
