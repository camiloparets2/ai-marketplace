// The single Claude Vision entry point (CLAUDE.md rule: nothing else in the
// app calls the Vision API directly). Wraps the extraction call and returns
// the launch pipeline's identification contract: the raw extraction plus an
// overall 0–1 confidence and the defect list the guardrails consume.

import Anthropic, {
  APIConnectionTimeoutError,
  RateLimitError,
  APIError,
} from "@anthropic-ai/sdk";
import { EXTRACTION_TOOL_SCHEMA } from "@/lib/types/extraction";
import type { ExtractionResult } from "@/lib/types/extraction";
import type { AcceptedMimeType } from "@/lib/image-validation";

// ─── Errors ───────────────────────────────────────────────────────────────────

export type VisionFailureKind =
  | "rate_limited"
  | "timeout"
  | "api_error"
  | "bad_response"
  | "unknown";

// Routes map kinds to HTTP responses; the pipeline maps them to review/retry.
export class VisionError extends Error {
  constructor(
    message: string,
    public readonly kind: VisionFailureKind,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "VisionError";
  }
}

// ─── Result contract ──────────────────────────────────────────────────────────

export interface IdentifiedItem {
  extraction: ExtractionResult;
  // Overall identification confidence 0–1. Conservative by construction: the
  // MINIMUM of the identity-critical field scores — one shaky field means the
  // whole identification is shaky.
  confidence: number;
  // Visible flaws (scratches, missing parts, …); mirrors extraction.defects.
  defects: string[];
}

// Pure math lives in lib/ai/confidence.ts (client-safe); re-exported so
// existing imports keep working.
export { overallConfidence } from "@/lib/ai/confidence";
import { overallConfidence } from "@/lib/ai/confidence";
import {
  applyBrandGuard,
  foldAspectsIntoSpecs,
  BRAND_DOWNGRADE_CONFIDENCE_CAP,
} from "@/lib/ai/brand-guard";

// ─── The Vision call ──────────────────────────────────────────────────────────

export const VISION_PROMPT = [
  "Analyze this product photo and extract all structured listing data.",
  "Look carefully at labels, barcodes, text, and physical characteristics.",
  "For dimensions and weight, use visual cues and reference objects if visible.",
  "Be precise about model numbers, UPCs, and technical specifications —",
  "accuracy prevents buyer returns on high-ticket items.",
  "BRAND: only report a brand you can actually READ in the photo — on a sewn",
  "tag, sticker, product label, or printed logo — and record where you read",
  "it in brandSource. NEVER infer a brand from styling, silhouette, or",
  "quality; if no brand text is readable, set brand to null and brandSource",
  "to 'none'. Listing an invented brand risks counterfeit takedowns.",
  "Also extract material, colors, size (and its US/UK/EU size system),",
  "style, and pattern when visible — buyers filter on these item specifics.",
  "List every visible defect honestly — scratches, dents, stains, missing",
  "parts — an empty defect list must mean the item truly looks flawless.",
  "Always recommend an asking price from the item's typical resale value in",
  "its visible condition, with a 1-2 sentence rationale citing the comparable",
  "market. If you're unsure, still price it and lower the confidence score —",
  "the seller edits the price either way.",
  "Set confidence scores honestly: 90+ only when you can read the value directly",
  "from the photo; 50-70 for reasonable inference; below 50 when uncertain.",
].join(" ");

// Lazily initialised — avoids import-time crash when ANTHROPIC_API_KEY is
// absent in local dev before .env.local is configured.
let _client: Anthropic | null = null;
function defaultClient(): Anthropic {
  _client ??= new Anthropic();
  return _client;
}

// The narrow slice of the SDK we use — lets tests inject a fake.
export type VisionClient = {
  messages: Pick<Anthropic["messages"], "create">;
};

export async function identifyItem(
  imageBase64: string,
  mimeType: AcceptedMimeType,
  client: VisionClient = defaultClient()
): Promise<IdentifiedItem> {
  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6",
        // Headroom for the full extraction plus the price rationale — a
        // truncated tool_use block fails JSON parsing inside the SDK.
        max_tokens: 1536,
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
              { type: "text", text: VISION_PROMPT },
            ],
          },
        ],
      },
      // Vision calls on complex images can take 15-20s; 30s gives headroom
      // without hanging the UI.
      { timeout: 30_000 }
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new VisionError(
        "Service is busy right now. Please wait a moment and try again.",
        "rate_limited",
        true
      );
    }
    if (err instanceof APIConnectionTimeoutError) {
      throw new VisionError(
        "Analysis timed out. Please try again — complex photos sometimes take longer.",
        "timeout",
        true
      );
    }
    if (err instanceof APIError) {
      console.error("[vision] Anthropic API error", err.status, err.message);
      throw new VisionError(
        "Analysis failed. Please try a different photo or try again shortly.",
        "api_error",
        true
      );
    }
    console.error("[vision] Unexpected error", err);
    throw new VisionError(
      "Something went wrong. Please try again.",
      "unknown",
      true
    );
  }

  // tool_choice: { type: 'tool' } guarantees a tool_use block; defensive
  // check in case of an unexpected API change.
  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    console.error("[vision] no tool_use block in response", response.content);
    throw new VisionError(
      "Analysis returned an unexpected response. Please try again.",
      "bad_response",
      true
    );
  }

  const raw = toolBlock.input as ExtractionResult;
  // Normalise fields a degraded response might omit: downstream code (and
  // the review UI's editable price) relies on null, not undefined. An
  // unsourced brand claim counts as "inferred" — the guard downgrades it.
  raw.suggestedPrice ??= null;
  raw.priceRationale ??= null;
  raw.brandSource ??= raw.brand ? "inferred" : "none";
  raw.material ??= null;
  raw.colorPrimary ??= null;
  raw.colorSecondary ??= null;
  raw.size ??= null;
  raw.sizeSystem ??= null;
  raw.style ??= null;
  raw.pattern ??= null;
  raw.specs ??= {};

  // Brand guard: never assert a brand that wasn't readable in the photo.
  // A downgrade caps overall confidence below the auto-post bar → review.
  const { extraction: guarded, downgraded } = applyBrandGuard(raw);
  const extraction = foldAspectsIntoSpecs(guarded);
  const confidence = downgraded
    ? Math.min(overallConfidence(extraction), BRAND_DOWNGRADE_CONFIDENCE_CAP)
    : overallConfidence(extraction);
  return {
    extraction,
    confidence,
    defects: extraction.defects ?? [],
  };
}
