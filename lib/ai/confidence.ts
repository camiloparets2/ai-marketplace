// Pure confidence math for identification results — shared by the server
// wrapper (lib/ai/vision.ts) and client screens (the identification card
// renders the meter in the browser). No SDK imports here: pulling vision.ts
// into a client bundle would drag @anthropic-ai/sdk with it.

import type { ExtractionResult } from "@/lib/types/extraction";

// The fields that decide whether we trust the identification itself.
// Shipping/dimension scores don't gate auto-posting; wrong titles do.
export const IDENTITY_FIELDS = ["title", "category", "condition"] as const;

// A field Claude populated but didn't score counts as a coin-flip, not a pass.
const UNSCORED_FIELD_SCORE = 50;

// Overall identification confidence 0–1. Conservative by construction: the
// MINIMUM of the identity-critical field scores — one shaky field means the
// whole identification is shaky.
export function overallConfidence(extraction: ExtractionResult): number {
  const scores = IDENTITY_FIELDS.map(
    (field) => extraction.confidence[field] ?? UNSCORED_FIELD_SCORE
  );
  return Math.min(1, Math.max(0, Math.min(...scores) / 100));
}
