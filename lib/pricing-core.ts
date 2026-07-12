// Pure pricing math (docs/design/launch.md P0-3) — shared by the server
// engine and client screens (the pricing panel computes floors in the
// browser). Dependency-free: no supabase, no network. Persistence lives
// in lib/pricing.ts.
//
// Every price the pipeline sets is derived from a FLOOR the seller can't
// lose money at. EXACT MODEL — the buyer pays shipping separately (the
// offer's shippingCostOverrides charges them the same `ship` the seller
// pays for the label, so those cancel), but eBay's final value fee applies
// to the TOTAL the buyer pays (item price + shipping):
//
//   net(price) = price - feeRate*(price + ship) - feeFlat - cost_basis
//   floor      = smallest price where net(price) >= min_margin(price)
//
// with min_margin(price) = max(minMarginFlat, minMarginPct * price).
//
// Solving both margin branches:
//   flat branch: price >= (cost + feeRate*ship + feeFlat + minMarginFlat) / (1 - feeRate)
//   pct  branch: price >= (cost + feeRate*ship + feeFlat) / (1 - feeRate - minMarginPct)
// floor = max of the two, rounded up to the cent.
//
// (The previous model folded 100% of `ship` into the floor — never a loss,
// but it priced heavy-cheap items roughly a full shipping cost above market
// while the buyer ALSO paid shipping at checkout.)
//
// ⚑ Defaults below are launch assumptions awaiting Camilo's confirmation —
// see the flag table in docs/design/launch.md.

import { MIN_SOLD_COMPS, compsTrusted } from "@/lib/comps";
import type { CompsSummary } from "@/lib/comps";

export interface PricingDefaults {
  // eBay final value fee ≈ 13.6% + $0.40 for most categories.
  feeRate: number;
  feeFlat: number;
  // min_margin = max(flat, pct * price)  ⚑
  minMarginFlat: number;
  minMarginPct: number;
  // no-comps strategy: price = floor * markup, styled to .99  ⚑
  markupOverFloor: number;
  // no cost basis entered → assume cost was this share of the market price
  // (comps median) so the floor isn't fantasy  ⚑
  assumedCostRate: number;
  // Comp-anchor adjustments (docs/design/comps-pricing.md ⚑): comps rarely
  // match condition exactly, so the anchor shifts by condition…
  conditionFactors: Record<
    "New" | "Like New" | "Very Good" | "Good" | "Acceptable",
    number
  >;
  // …down per visible defect (capped)…
  defectPenaltyRate: number;
  maxDefectPenalty: number;
  // …and up slightly when explicitly complete/in-box.
  completenessBonus: number;
}

export const PRICING_DEFAULTS: PricingDefaults = {
  feeRate: 0.136,
  feeFlat: 0.4,
  minMarginFlat: 3,
  minMarginPct: 0.15,
  markupOverFloor: 1.2,
  assumedCostRate: 0.3,
  conditionFactors: {
    New: 1.05,
    "Like New": 1.0,
    "Very Good": 0.95,
    Good: 0.88,
    Acceptable: 0.78,
  },
  defectPenaltyRate: 0.03,
  maxDefectPenalty: 0.15,
  completenessBonus: 1.05,
};

export type PriceStrategy =
  | "user_target"
  | "comps"
  // Claude Vision's estimate, kept ONLY when comps are sparse/absent — the
  // price_ungrounded guardrail routes such items to review, never auto-publish.
  | "ai_estimate"
  | "floor_markup";

export interface PriceDecision {
  price: number;
  // null → floor uncomputable (no shipping estimate). Such an item can never
  // pass the price_floor guardrail and is held for review.
  floor: number | null;
  strategy: PriceStrategy;
  rationale: string;
  // True only when the price is anchored to trusted market data (comps) or
  // set by the seller. Ungrounded prices fail the price_ungrounded
  // guardrail → review, never auto-publish.
  grounded: boolean;
  // The values the decision was computed from, persisted for the audit row
  // (price_history.inputs jsonb) — including the comps snapshot.
  inputs: Record<string, number | string | null>;
}

export interface PriceRequest {
  costBasis: number | null;
  shippingCost: number | null;
  // A price the seller asked for, if any — always wins (clamped to floor).
  targetPrice: number | null;
  // Market comps when available; null/omitted → conservative fallback.
  comps?: CompsSummary | null;
  // Claude Vision's estimate — the seed kept (with lower confidence and a
  // review hold) when comps are sparse; ignored when comps anchor.
  aiSuggestedPrice?: number | null;
  // Condition/defect/completeness adjustments to the comp anchor.
  condition?: "New" | "Like New" | "Very Good" | "Good" | "Acceptable" | null;
  defectCount?: number;
  completeInBox?: boolean;
}

const roundUpCent = (n: number): number => Math.ceil(n * 100) / 100;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Retail-style .99 ending that never dips below the input.
export function styleTo99(n: number): number {
  const styled = Math.ceil(n) - 0.01;
  return round2(styled >= n ? styled : Math.ceil(n) + 0.99);
}

/**
 * The break-even floor, or NULL when it cannot be computed.
 *
 * MONEY RULE: unknown shipping is never coerced to $0. `shippingCost` is
 * null exactly when the extraction says MANUAL_ESTIMATE_NEEDED — which by
 * its own definition includes "too large for any flat-rate box", i.e. the
 * items where shipping is MOST expensive (live bug: 50 lb concrete priced
 * $6.50 with free shipping). A null floor means "this item is not safe to
 * price or auto-publish until a shipping cost exists" — mirror of the
 * explicit assumedCost ⚑ pattern used for a missing cost basis: loud,
 * never silent. (Even in the exact model the fee-on-shipping term is
 * unknowable without a shipping cost, and the offer builder refuses to
 * publish without one anyway.)
 *
 * Shipping enters the floor only as feeRate * shippingCost: the buyer pays
 * shipping at checkout (offer shippingCostOverrides), the label cancels it,
 * and what remains is eBay's fee on that shipping revenue.
 */
export function computeFloor(
  costBasis: number | null,
  shippingCost: number | null,
  d: PricingDefaults = PRICING_DEFAULTS
): number | null {
  if (shippingCost === null) return null;
  const cost = costBasis ?? 0;
  const feeOnShipping = d.feeRate * shippingCost;
  const flatBranch =
    (cost + feeOnShipping + d.feeFlat + d.minMarginFlat) / (1 - d.feeRate);
  const pctBranch =
    (cost + feeOnShipping + d.feeFlat) / (1 - d.feeRate - d.minMarginPct);
  return roundUpCent(Math.max(flatBranch, pctBranch));
}

export function decidePrice(
  req: PriceRequest,
  d: PricingDefaults = PRICING_DEFAULTS
): PriceDecision {
  const comps = req.comps ?? null;
  // A band trustworthy enough to ANCHOR: sold ≥ MIN_SOLD_COMPS, or (no MI
  // grant) a wide-enough active band — see compsTrusted/⚑ thresholds.
  const trustedComps = compsTrusted(comps);

  // Cost-basis fallback (P1-4 ⚑): with no entered cost but trusted comps,
  // assume cost was assumedCostRate × market price so the floor is honest.
  const assumedCost =
    req.costBasis === null && trustedComps && comps.medianPrice !== null
      ? round2(d.assumedCostRate * comps.medianPrice)
      : null;
  const effectiveCost = req.costBasis ?? assumedCost;

  const floor = computeFloor(effectiveCost, req.shippingCost, d);
  // Full comps snapshot — persisted to price_history.inputs for audit.
  const inputs: Record<string, number | string | null> = {
    costBasis: req.costBasis,
    assumedCost,
    shippingCost: req.shippingCost,
    targetPrice: req.targetPrice,
    aiSuggestedPrice: req.aiSuggestedPrice ?? null,
    compsMedian: comps?.medianPrice ?? null,
    compsLow: comps?.lowPrice ?? null,
    compsHigh: comps?.highPrice ?? null,
    compsSampleSize: comps?.sampleSize ?? null,
    compsSource: comps?.source ?? null,
    compsDemand: comps?.demandSignal ?? null,
    compsFetchedAt: comps?.fetchedAt ?? null,
    compsMedianSold: comps?.medianSoldPrice ?? null,
    compsSoldCount: comps?.soldCount ?? null,
    compsActiveCount: comps?.activeCount ?? null,
    feeRate: d.feeRate,
    feeFlat: d.feeFlat,
    minMarginFlat: d.minMarginFlat,
    minMarginPct: d.minMarginPct,
  };
  const costNote =
    req.costBasis !== null
      ? ""
      : assumedCost !== null
        ? ` No cost basis entered — assumed $${assumedCost.toFixed(2)} (${Math.round(d.assumedCostRate * 100)}% of the comp median); enter cost of goods for a real floor.`
        : " No cost basis recorded — floor assumes $0 cost; enter cost of goods for a real floor.";
  // Loud, never silent: with no shipping estimate there IS no floor and no
  // profitability claim — the item is held for review (guardrail).
  const noFloorNote =
    " No shipping estimate — the break-even floor can't be computed, so this item needs a shipping cost before it can publish.";

  if (req.targetPrice !== null) {
    const price =
      floor === null ? round2(req.targetPrice) : round2(Math.max(req.targetPrice, floor));
    const raised = floor !== null && req.targetPrice < floor;
    return {
      price,
      floor,
      grounded: true, // the seller chose it
      strategy: "user_target",
      rationale:
        `Seller target $${req.targetPrice.toFixed(2)}` +
        (floor === null
          ? " noted." + noFloorNote
          : raised
            ? `, raised to the $${floor.toFixed(2)} floor (cost + fees incl. on shipping + minimum margin).`
            : ` accepted — at or above the $${floor.toFixed(2)} floor.`) +
        costNote,
      inputs,
    };
  }

  if (trustedComps && comps.medianPrice !== null) {
    // Anchor to the market median, adjusted for condition (comps rarely
    // match it exactly), down for visible defects, up when explicitly
    // complete/in-box — then ALWAYS clamped to the floor (the #23/#24
    // money rules are untouched).
    const conditionFactor = req.condition ? d.conditionFactors[req.condition] : 1;
    const defectPenalty = Math.min(
      (req.defectCount ?? 0) * d.defectPenaltyRate,
      d.maxDefectPenalty
    );
    const completeness = req.completeInBox ? d.completenessBonus : 1;
    const adjusted =
      comps.medianPrice * conditionFactor * (1 - defectPenalty) * completeness;
    inputs.compsAdjustedAnchor = round2(adjusted);

    const price =
      floor === null ? styleTo99(adjusted) : styleTo99(Math.max(adjusted, floor));
    const sourceNote =
      comps.source === "sold"
        ? `${comps.sampleSize} sold comp(s)`
        : `${comps.sampleSize} ACTIVE listing(s) — sold data pending eBay Marketplace Insights approval, treat as an asking-price band`;
    const adjustNote =
      conditionFactor !== 1 || defectPenalty > 0 || completeness !== 1
        ? ` Adjusted for ${req.condition ?? "condition"}${
            defectPenalty > 0 ? `, ${req.defectCount} defect(s)` : ""
          }${completeness !== 1 ? ", complete-in-box" : ""}.`
        : "";
    const activeNote =
      comps.activeCount !== null
        ? ` ${comps.activeCount} active competing listing(s).`
        : "";
    return {
      price,
      floor,
      grounded: true,
      strategy: "comps",
      rationale:
        `Market-priced from ${sourceNote}: $${(comps.lowPrice ?? comps.medianPrice).toFixed(2)}–$${(comps.highPrice ?? comps.medianPrice).toFixed(2)} band, median $${comps.medianPrice.toFixed(2)}, demand ${comps.demandSignal}.` +
        adjustNote +
        (floor === null
          ? noFloorNote
          : ` Clamped to the $${floor.toFixed(2)} floor.`) +
        activeNote +
        costNote,
      inputs,
    };
  }

  // ── No trusted comps: the AI estimate is kept as the SEED, clearly
  // labeled ungrounded — the price_ungrounded guardrail holds the item for
  // review. Never auto-published. Mirrors the assumedCost ⚑ pattern.
  const aiSeed = req.aiSuggestedPrice ?? null;
  if (aiSeed !== null && aiSeed > 0) {
    const price = floor === null ? round2(aiSeed) : round2(Math.max(aiSeed, floor));
    const sparse =
      comps !== null
        ? ` Comps too sparse to trust (${comps.sampleSize} ${comps.source}).`
        : " No comparable listings found.";
    return {
      price,
      floor,
      grounded: false,
      strategy: "ai_estimate",
      rationale:
        `AI estimate $${aiSeed.toFixed(2)} — NOT grounded in market comps; held for your review.` +
        sparse +
        (floor === null
          ? noFloorNote
          : floor > aiSeed
            ? ` Raised to the $${floor.toFixed(2)} floor.`
            : "") +
        costNote,
      inputs,
    };
  }

  const sparseComps = req.comps ?? null;
  const sparseNote =
    sparseComps !== null && !trustedComps
      ? ` Comps too sparse to trust (${sparseComps.soldCount} sold < ${MIN_SOLD_COMPS}) — priced conservatively with lower confidence.`
      : "";
  if (floor === null) {
    // Seed a price so the draft isn't blank, computed WITHOUT any shipping
    // term and never presented as a floor — the null floor keeps the item
    // out of auto-publish regardless.
    const seedBase = computeFloor(effectiveCost, 0, d);
    const price = styleTo99((seedBase ?? d.minMarginFlat) * d.markupOverFloor);
    return {
      price,
      floor: null,
      grounded: false,
      strategy: "floor_markup",
      rationale:
        `Provisional price (excludes shipping entirely).` +
        noFloorNote +
        sparseNote +
        costNote,
      inputs,
    };
  }
  const price = styleTo99(floor * d.markupOverFloor);
  return {
    price,
    floor,
    grounded: false,
    strategy: "floor_markup",
    rationale:
      `No trusted comps — priced at floor $${floor.toFixed(2)} × ${d.markupOverFloor} markup, styled to .99.` +
      sparseNote +
      costNote,
    inputs,
  };
}
