// Auto-post guardrails (docs/design/launch.md P0-5).
//
// The pipeline publishes WITHOUT a human only when every gate passes.
// Any failure routes the item to status=review with the failing gates
// recorded — a human decision, never a silent drop.
//
// All pure functions — no network, no DB — so every gate is unit-testable.
//
// ⚑ Thresholds and lists below are launch defaults awaiting Camilo's
// confirmation — see the flag table in docs/design/launch.md.

import { detectFormat } from "@/lib/image-validation";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface GuardrailConfig {
  // identification confidence 0-1 required to auto-post  ⚑
  minConfidence: number;
  // sane absolute price range for unsupervised posting  ⚑
  sanePriceMin: number;
  sanePriceMax: number;
  // a 2048px listing photo below this is a thumbnail, a blank, or junk  ⚑
  minPhotoBytes: number;
}

export const GUARDRAIL_DEFAULTS: GuardrailConfig = {
  minConfidence: 0.8,
  sanePriceMin: 5,
  sanePriceMax: 2000,
  minPhotoBytes: 25 * 1024,
};

// Categories eBay prohibits or heavily restricts, matched as whole words in
// the title/category/specs text. Starter list — expand from eBay's
// prohibited-items policy as real traffic shows gaps.  ⚑
const PROHIBITED_PATTERNS: ReadonlyArray<RegExp> = [
  /\bguns?\b/i,
  /\bfirearms?\b/i,
  /\bammunition\b/i,
  /\bammo\b/i,
  /\bexplosives?\b/i,
  /\bfireworks?\b/i,
  /\bswitchblades?\b/i,
  /\bbrass knuckles\b/i,
  /\btasers?\b/i,
  /\bpepper spray\b/i,
  /\bprescription\b/i,
  /\bcontrolled substance\b/i,
  /\bnarcotics?\b/i,
  /\bcannabis\b/i,
  /\bcbd\b/i,
  /\bvapes?\b/i,
  /\be-?cigarettes?\b/i,
  /\btobacco\b/i,
  /\balcohol\b/i,
  /\bcounterfeits?\b/i,
  /\breplicas?\b/i,
  /\bknock-?offs?\b/i,
  /\bstolen\b/i,
  /\brecalled\b/i,
  /\bivory\b/i,
  /\bendangered\b/i,
  /\bhazardous\b/i,
  /\block ?picks?\b/i,
];

// Brands with aggressive VeRO enforcement / gating on eBay. A hit does NOT
// block the listing — it routes to review so a human vouches for
// authenticity before we auto-post under our name. Starter list.  ⚑
const VERO_BRANDS: ReadonlyArray<string> = [
  "louis vuitton",
  "gucci",
  "chanel",
  "hermes",
  "hermès",
  "rolex",
  "cartier",
  "prada",
  "dior",
  "fendi",
  "burberry",
  "versace",
  "balenciaga",
  "tiffany",
  "supreme",
  "ugg",
  "pandora",
  "swarovski",
];

// ─── Gate results ─────────────────────────────────────────────────────────────

export type GateName =
  | "confidence"
  | "price_floor"
  | "price_range"
  | "prohibited_item"
  | "vero_brand"
  | "photo_quality"
  | "shipping_unknown"
  // The price is not anchored to trusted market comps (or a seller target) —
  // an ungrounded price never auto-publishes (docs/design/comps-pricing.md).
  | "price_ungrounded";

export interface GateResult {
  gate: GateName;
  pass: boolean;
  // Human-readable — shown in the review queue as "why is this here?"
  reason: string;
}

export interface GuardrailVerdict {
  autoPost: boolean;
  gates: GateResult[];
  failures: GateResult[];
}

// ─── Individual gates ─────────────────────────────────────────────────────────

export function confidenceGate(
  confidence: number,
  cfg: GuardrailConfig = GUARDRAIL_DEFAULTS
): GateResult {
  const pass = confidence >= cfg.minConfidence;
  return {
    gate: "confidence",
    pass,
    reason: pass
      ? `identification confidence ${confidence.toFixed(2)} ≥ ${cfg.minConfidence}`
      : `identification confidence ${confidence.toFixed(2)} below the ${cfg.minConfidence} auto-post bar`,
  };
}

export function priceFloorGate(
  price: number,
  floor: number | null
): GateResult {
  // A null floor means the break-even is UNKNOWN (no shipping estimate).
  // Unknown profitability never auto-posts — the live money bug this guards
  // against was $6.50 concrete shipped free at a $30-60 loss.
  if (floor === null) {
    return {
      gate: "price_floor",
      pass: false,
      reason:
        "break-even floor unknown — no shipping estimate, so profitability can't be verified",
    };
  }
  const pass = price >= floor;
  return {
    gate: "price_floor",
    pass,
    reason: pass
      ? `price $${price.toFixed(2)} covers the $${floor.toFixed(2)} floor`
      : `price $${price.toFixed(2)} is below the $${floor.toFixed(2)} floor (cost + fees incl. on shipping + margin)`,
  };
}

export function priceRangeGate(
  price: number,
  cfg: GuardrailConfig = GUARDRAIL_DEFAULTS
): GateResult {
  const pass = price >= cfg.sanePriceMin && price <= cfg.sanePriceMax;
  return {
    gate: "price_range",
    pass,
    reason: pass
      ? `price $${price.toFixed(2)} within the $${cfg.sanePriceMin}–$${cfg.sanePriceMax} auto-post range`
      : `price $${price.toFixed(2)} outside the $${cfg.sanePriceMin}–$${cfg.sanePriceMax} auto-post range — a human should sanity-check it`,
  };
}

export function prohibitedItemGate(listingText: string): GateResult {
  const hit = PROHIBITED_PATTERNS.find((p) => p.test(listingText));
  return {
    gate: "prohibited_item",
    pass: !hit,
    reason: hit
      ? `matched restricted-item pattern ${String(hit)}`
      : "no prohibited/restricted keywords",
  };
}

export function veroBrandGate(brand: string | null, title: string): GateResult {
  const haystack = `${brand ?? ""} ${title}`.toLowerCase();
  const hit = VERO_BRANDS.find((b) => haystack.includes(b));
  return {
    gate: "vero_brand",
    pass: !hit,
    reason: hit
      ? `brand "${hit}" is on the VeRO/gated-brand watch list — verify authenticity before posting`
      : "brand not on the VeRO watch list",
  };
}

// Basic photo quality bar. Server-side we have bytes, not pixels: a real
// listing photo (≤2048px, JPEG q0.85) below ~25KB is a thumbnail, a blank
// wall, or corrupt. Decode-level checks (blur/exposure) are a P2 upgrade.
export function photoQualityGate(
  photoBytes: Uint8Array | null,
  cfg: GuardrailConfig = GUARDRAIL_DEFAULTS
): GateResult {
  if (photoBytes === null || photoBytes.length === 0) {
    return {
      gate: "photo_quality",
      pass: false,
      reason: "no photo available for the listing",
    };
  }
  if (detectFormat(photoBytes) === null || detectFormat(photoBytes) === "heic") {
    return {
      gate: "photo_quality",
      pass: false,
      reason: "photo is not a marketplace-ready JPEG/PNG/WebP",
    };
  }
  const pass = photoBytes.length >= cfg.minPhotoBytes;
  return {
    gate: "photo_quality",
    pass,
    reason: pass
      ? `photo passes the basic quality bar (${Math.round(photoBytes.length / 1024)}KB)`
      : `photo is only ${Math.round(photoBytes.length / 1024)}KB — too small to be a usable listing photo`,
  };
}

// The item has no shipping estimate at all (MANUAL_ESTIMATE_NEEDED — often
// "too large for any flat-rate box", i.e. the most expensive items to ship).
// A human must supply a shipping cost before this can publish anywhere.
export function priceGroundedGate(grounded: boolean): GateResult {
  return {
    gate: "price_ungrounded",
    pass: grounded,
    reason: grounded
      ? "price anchored to market comps or a seller target"
      : "price is an AI estimate with no trusted market comps — confirm or adjust it before posting",
  };
}

export function shippingKnownGate(shippingCost: number | null): GateResult {
  const pass = shippingCost !== null;
  return {
    gate: "shipping_unknown",
    pass,
    reason: pass
      ? `shipping estimated at $${(shippingCost as number).toFixed(2)}`
      : "no shipping estimate — enter a shipping cost or pick a service before this item can publish",
  };
}

// ─── The combined verdict ─────────────────────────────────────────────────────

export interface GuardrailInput {
  confidence: number;
  price: number;
  // null → break-even unknown (no shipping estimate); always fails the gate.
  floor: number | null;
  // whether the price decision was grounded (comps/seller target)
  priceGrounded: boolean;
  // the shipping estimate the floor was built from; null → shipping_unknown
  shippingCost: number | null;
  title: string;
  brand: string | null;
  category: string;
  specs: Record<string, string>;
  defects: string[];
  photoBytes: Uint8Array | null;
}

export function evaluateGuardrails(
  input: GuardrailInput,
  cfg: GuardrailConfig = GUARDRAIL_DEFAULTS
): GuardrailVerdict {
  const listingText = [
    input.title,
    input.category,
    ...Object.entries(input.specs).flatMap(([k, v]) => [k, v]),
    ...input.defects,
  ].join(" ");

  const gates: GateResult[] = [
    confidenceGate(input.confidence, cfg),
    shippingKnownGate(input.shippingCost),
    priceGroundedGate(input.priceGrounded),
    priceFloorGate(input.price, input.floor),
    priceRangeGate(input.price, cfg),
    prohibitedItemGate(listingText),
    veroBrandGate(input.brand, input.title),
    photoQualityGate(input.photoBytes, cfg),
  ];
  const failures = gates.filter((g) => !g.pass);
  return { autoPost: failures.length === 0, gates, failures };
}
