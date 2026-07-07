// Auto-list pipeline route: one photo in → identified, persisted, priced,
// and (sandbox/dry-run — see lib/pipeline.ts SAFETY note) published.
// The manual flow (/api/analyze + /api/publish) is unchanged; this is the
// "snap and it's listed" path.

export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { validateImageBytes } from "@/lib/image-validation";
import type { AcceptedMimeType } from "@/lib/image-validation";
import { VisionError } from "@/lib/ai/vision";
import { runPipeline } from "@/lib/pipeline";
import { requireUser } from "@/lib/auth/guard";
import { checkRateLimit, requestIdentity, RATE_RULES } from "@/lib/rate-limit";
import { spendCredits, refundCredits } from "@/lib/billing/credits";
import { CREDIT_COST_AI_EXTRACTION } from "@/lib/billing/plans";

interface PipelineBody {
  image: string;
  mimeType: AcceptedMimeType;
  costBasis?: number;
  targetPrice?: number;
}

function parseBody(raw: unknown): PipelineBody | string {
  const body = raw as Partial<PipelineBody> | null;
  if (!body || typeof body !== "object") return "Invalid request body";
  if (typeof body.image !== "string" || !body.image) return "Missing image";
  if (
    body.mimeType !== "image/jpeg" &&
    body.mimeType !== "image/png" &&
    body.mimeType !== "image/webp"
  )
    return "mimeType must be image/jpeg, image/png, or image/webp";
  for (const key of ["costBasis", "targetPrice"] as const) {
    const value = body[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !isFinite(value) || value < 0)
    )
      return `${key} must be a non-negative number`;
  }
  return {
    image: body.image,
    mimeType: body.mimeType,
    costBasis: body.costBasis,
    targetPrice: body.targetPrice,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Pipeline runs are user-scoped (they write inventory + use the user's
  // eBay connection) — a beta key alone is not enough.
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await checkRateLimit(
    RATE_RULES.publish,
    requestIdentity(req, user.id)
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many listings too fast — please wait a bit and try again." },
      { status: 429 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if (typeof parsed === "string") {
    return NextResponse.json({ error: parsed }, { status: 400 });
  }

  const imageBytes = new Uint8Array(Buffer.from(parsed.image, "base64"));
  const validation = validateImageBytes(imageBytes);
  if (!validation.valid) {
    return NextResponse.json(
      { error: validation.error ?? "Invalid image" },
      { status: 400 }
    );
  }

  // One AI credit per pipeline run, refunded when identification fails.
  const requestId = randomUUID();
  const spend = await spendCredits(
    user.id,
    CREDIT_COST_AI_EXTRACTION,
    "ai_pipeline_run",
    requestId
  );
  if (!spend.ok && spend.reason === "no_credits") {
    return NextResponse.json(
      {
        error: "You're out of AI credits. Upgrade your plan to keep listing.",
        code: "no_credits",
        renewsAt: spend.status.periodEnd,
      },
      { status: 402 }
    );
  }
  const credited = spend.ok;

  try {
    const result = await runPipeline({
      userId: user.id,
      imageBase64: parsed.image,
      mimeType: parsed.mimeType,
      costBasis: parsed.costBasis ?? null,
      targetPrice: parsed.targetPrice ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    // Identification failed → the run produced nothing; return the credit.
    if (credited) {
      await refundCredits(user.id, CREDIT_COST_AI_EXTRACTION, requestId);
    }
    if (err instanceof VisionError) {
      const status =
        err.kind === "rate_limited"
          ? 429
          : err.kind === "timeout"
            ? 504
            : err.kind === "api_error"
              ? 502
              : 500;
      return NextResponse.json(
        { error: err.message, retryable: err.retryable },
        { status }
      );
    }
    console.error("[pipeline] run failed", err);
    return NextResponse.json(
      { error: "Pipeline failed. Please try again." },
      { status: 500 }
    );
  }
}
