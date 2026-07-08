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

// ─── The Vision call ──────────────────────────────────────────────────────────

export const VISION_PROMPT = [
  "Analyze this product photo and extract all structured listing data.",
  "Look carefully at labels, barcodes, text, and physical characteristics.",
  "For dimensions and weight, use visual cues and reference objects if visible.",
  "Be precise about model numbers, UPCs, and technical specifications —",
  "accuracy prevents buyer returns on high-ticket items.",
  "List every visible defect honestly — scratches, dents, stains, missing",
  "parts — an empty defect list must mean the item truly looks flawless.",
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

  const extraction = toolBlock.input as ExtractionResult;
  return {
    extraction,
    confidence: overallConfidence(extraction),
    defects: extraction.defects ?? [],
  };
}
