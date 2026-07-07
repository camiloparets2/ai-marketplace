// Channel routing table (docs/design/launch.md P1-1).
//
// Rule (Camilo's ground truth): **eBay is the default flip channel for
// everything.** Etsy is allowed ONLY when the item genuinely qualifies under
// Etsy's own policy — handmade, vintage 20+ years old, or a craft supply —
// and is NEVER auto-selected otherwise. A second general flip channel is
// deferred (the table below is where it will slot in).  ⚑
//
// Pure and unit-tested; the pipeline consults this after identification.

import type { ExtractionResult } from "@/lib/types/extraction";

export const VINTAGE_MIN_AGE_YEARS = 20;

export type RoutedChannel = "ebay" | "etsy";

export interface RoutingDecision {
  channels: RoutedChannel[];
  etsyEligible: boolean;
  // Which Etsy door the item qualifies through, when it does.
  etsyBasis: "handmade" | "vintage" | "craft_supply" | null;
  rationale: string;
}

export function etsyEligibility(
  extraction: Pick<
    ExtractionResult,
    "handmade" | "estimatedYearMade" | "craftSupply"
  >,
  now: Date = new Date()
): { eligible: boolean; basis: RoutingDecision["etsyBasis"] } {
  if (extraction.handmade) return { eligible: true, basis: "handmade" };
  if (extraction.craftSupply) return { eligible: true, basis: "craft_supply" };
  if (
    extraction.estimatedYearMade !== null &&
    now.getFullYear() - extraction.estimatedYearMade >= VINTAGE_MIN_AGE_YEARS
  ) {
    return { eligible: true, basis: "vintage" };
  }
  return { eligible: false, basis: null };
}

export function routeChannels(
  extraction: Pick<
    ExtractionResult,
    "handmade" | "estimatedYearMade" | "craftSupply"
  >,
  now: Date = new Date()
): RoutingDecision {
  const { eligible, basis } = etsyEligibility(extraction, now);
  if (!eligible) {
    return {
      channels: ["ebay"],
      etsyEligible: false,
      etsyBasis: null,
      rationale:
        "eBay (default channel). Etsy skipped — not handmade, vintage 20+ years, or a craft supply.",
    };
  }
  const why =
    basis === "handmade"
      ? "handmade"
      : basis === "craft_supply"
        ? "a craft supply"
        : `vintage (made ~${extraction.estimatedYearMade})`;
  return {
    channels: ["ebay", "etsy"],
    etsyEligible: true,
    etsyBasis: basis,
    rationale: `eBay (default channel) + Etsy — item qualifies as ${why}.`,
  };
}
