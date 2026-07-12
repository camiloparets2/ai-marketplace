// Brand-hallucination guard + aspect folding (docs/design/comps-pricing.md,
// Part 2). Pure — no SDK imports — so the extraction post-processing is
// testable without the Vision API and safe to reuse anywhere.
//
// The rule: a brand is only ASSERTED when it was actually READABLE in the
// photo. "I recognize this styling as Nike" is exactly how invented brands
// end up on listings (a VeRO/INAD risk), so styling inference always
// downgrades to "Unbranded" with lowered confidence.

import type { ExtractionResult } from "@/lib/types/extraction";

// A brand claim must score at least this to survive the guard.
export const BRAND_CONFIDENCE_BAR = 80;
// A downgraded claim keeps at most this brand confidence — visible in the
// UI's needs-review indicator (< CONFIDENCE_THRESHOLD of 60).
export const DOWNGRADED_BRAND_CONFIDENCE = 40;
// A downgrade also caps the OVERALL identification confidence below the
// 0.8 auto-post bar (lib/guardrails GUARDRAIL_DEFAULTS.minConfidence), so a
// suspect brand always routes to review instead of auto-publishing.
export const BRAND_DOWNGRADE_CONFIDENCE_CAP = 0.75;

// Compact cross-check list for LOGO reads only — a logo claim for a brand
// nobody has heard of is far more likely a hallucination than a real read.
// Tag/label reads are NEVER checked against this list: a niche-but-real
// brand printed on a tag must survive.
const KNOWN_BRANDS = new Set(
  [
    "adidas", "apple", "black+decker", "bosch", "bose", "brooks", "canon",
    "carhartt", "casio", "champion", "coach", "columbia", "converse",
    "cuisinart", "dell", "dewalt", "disney", "dr martens", "dyson", "fila",
    "fossil", "garmin", "gucci", "hamilton beach", "hp", "instant pot",
    "jbl", "kate spade", "kitchenaid", "lego", "lenovo", "levis", "lg",
    "louis vuitton", "makita", "michael kors", "milwaukee", "new balance",
    "nike", "nikon", "nintendo", "panasonic", "patagonia", "polo ralph lauren",
    "prada", "puma", "ralph lauren", "ray ban", "reebok", "ryobi", "samsung",
    "sony", "stanley", "the north face", "timberland", "tommy hilfiger",
    "under armour", "vans", "yeti",
  ].map((b) => b.replace(/[^a-z0-9 ]/g, ""))
);

function normalizeBrand(brand: string): string {
  return brand.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

export function isKnownBrand(brand: string): boolean {
  return KNOWN_BRANDS.has(normalizeBrand(brand));
}

export interface BrandGuardResult {
  extraction: ExtractionResult;
  // True when a claimed brand was replaced with "Unbranded" — the caller
  // caps overall confidence so the item goes to review.
  downgraded: boolean;
}

/** Enforce "only assert a READABLE brand". Downgrades to "Unbranded" when
 *  the brand was inferred from styling, scored below the confidence bar, or
 *  was a logo read that fails the known-brands cross-check. */
export function applyBrandGuard(extraction: ExtractionResult): BrandGuardResult {
  const brand = extraction.brand?.trim() || null;

  // Nothing claimed (or already "Unbranded") — just normalize the fields.
  if (brand === null || normalizeBrand(brand) === "unbranded") {
    if (extraction.brand === brand && extraction.brandSource === "none") {
      return { extraction, downgraded: false };
    }
    return {
      extraction: { ...extraction, brand, brandSource: "none" },
      downgraded: false,
    };
  }

  // Unscored brand counts as a coin-flip, not a pass (same rule as
  // lib/ai/confidence.ts).
  const conf = extraction.confidence.brand ?? 50;
  const readable =
    extraction.brandSource === "tag_or_label" ||
    (extraction.brandSource === "logo" && isKnownBrand(brand));

  if (readable && conf >= BRAND_CONFIDENCE_BAR) {
    return { extraction, downgraded: false };
  }

  return {
    extraction: {
      ...extraction,
      brand: "Unbranded",
      brandSource: "none",
      confidence: {
        ...extraction.confidence,
        brand: Math.min(conf, DOWNGRADED_BRAND_CONFIDENCE),
      },
    },
    downgraded: true,
  };
}

// eBay aspect names the structured fields map to (getItemAspectsForCategory
// requires/recommends these in most clothing & home categories).
const ASPECT_NAMES = [
  ["Material", "material"],
  ["Color", "colorPrimary"],
  ["Secondary Color", "colorSecondary"],
  ["Size", "size"],
  ["Size System", "sizeSystem"],
  ["Style", "style"],
  ["Pattern", "pattern"],
] as const;

/** Fold the aspect-mapped fields into `specs` under their eBay aspect names
 *  so they flow to item specifics (and tighten comps queries) with no extra
 *  plumbing. Existing spec keys win — never overwrites what Claude already
 *  put there. */
export function foldAspectsIntoSpecs(
  extraction: ExtractionResult
): ExtractionResult {
  const specs = { ...extraction.specs };
  for (const [aspect, field] of ASPECT_NAMES) {
    const value = extraction[field];
    if (typeof value === "string" && value.trim() && specs[aspect] === undefined) {
      specs[aspect] = value.trim();
    }
  }
  return { ...extraction, specs };
}
