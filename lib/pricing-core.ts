// Pure pricing math (docs/design/launch.md P0-3) — shared by the server
// engine and client screens (the pricing panel computes floors in the
// browser). Dependency-free: no supabase, no network. Persistence lives
// in lib/pricing.ts.
//
// Every price the pipeline sets is derived from a FLOOR the seller can't
// lose money at:
//
//   floor = smallest price where
//           price - fees(price) - shipping - cost_basis >= min_margin(price)
//
// with fees(price) = feeRate * price + feeFlat and
// min_margin(price) = max(minMarginFlat, minMarginPct * price).
//
// Solving both margin branches:
//   flat branch: price >= (cost + ship + feeFlat + minMarginFlat) / (1 - feeRate)
//   pct  branch: price >= (cost + ship + feeFlat) / (1 - feeRate - minMarginPct)
// floor = max of the two, rounded up to the cent.
//
// ⚑ Defaults below are launch assumptions awaiting Camilo's confirmation —
// see the flag table in docs/design/launch.md.

import { MIN_SOLD_COMPS } from "@/lib/comps";
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
}

export const PRICING_DEFAULTS: PricingDefaults = {
  feeRate: 0.136,
  feeFlat: 0.4,
  minMarginFlat: 3,
  minMarginPct: 0.15,
  markupOverFloor: 1.2,
  assumedCostRate: 0.3,
};

export type PriceStrategy = "user_target" | "floor_markup" | "comps";

export interface PriceDecision {
  price: number;
  floor: number;
  strategy: PriceStrategy;
  rationale: string;
  // The numbers the decision was computed from, persisted for the audit row.
  inputs: Record<string, number | null>;
}

export interface PriceRequest {
  costBasis: number | null;
  shippingCost: number | null;
  // A price the seller asked for, if any — always wins (clamped to floor).
  targetPrice: number | null;
  // Market comps when available; null/omitted → conservative fallback.
  comps?: CompsSummary | null;
}

const roundUpCent = (n: number): number => Math.ceil(n * 100) / 100;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Retail-style .99 ending that never dips below the input.
export function styleTo99(n: number): number {
  const styled = Math.ceil(n) - 0.01;
  return round2(styled >= n ? styled : Math.ceil(n) + 0.99);
}

export function computeFloor(
  costBasis: number | null,
  shippingCost: number | null,
  d: PricingDefaults = PRICING_DEFAULTS
): number {
  const cost = costBasis ?? 0;
  const ship = shippingCost ?? 0;
  const flatBranch = (cost + ship + d.feeFlat + d.minMarginFlat) / (1 - d.feeRate);
  const pctBranch = (cost + ship + d.feeFlat) / (1 - d.feeRate - d.minMarginPct);
  return roundUpCent(Math.max(flatBranch, pctBranch));
}

export function decidePrice(
  req: PriceRequest,
  d: PricingDefaults = PRICING_DEFAULTS
): PriceDecision {
  const comps = req.comps ?? null;
  const trustedComps =
    comps !== null &&
    comps.medianSoldPrice !== null &&
    comps.soldCount >= MIN_SOLD_COMPS;

  // Cost-basis fallback (P1-4 ⚑): with no entered cost but trusted comps,
  // assume cost was assumedCostRate × market price so the floor is honest.
  const assumedCost =
    req.costBasis === null && trustedComps && comps.medianSoldPrice !== null
      ? round2(d.assumedCostRate * comps.medianSoldPrice)
      : null;
  const effectiveCost = req.costBasis ?? assumedCost;

  const floor = computeFloor(effectiveCost, req.shippingCost, d);
  const inputs: Record<string, number | null> = {
    costBasis: req.costBasis,
    assumedCost,
    shippingCost: req.shippingCost,
    targetPrice: req.targetPrice,
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

  if (req.targetPrice !== null) {
    const price = round2(Math.max(req.targetPrice, floor));
    const raised = req.targetPrice < floor;
    return {
      price,
      floor,
      strategy: "user_target",
      rationale:
        `Seller target $${req.targetPrice.toFixed(2)}` +
        (raised
          ? `, raised to the $${floor.toFixed(2)} floor (cost + fees + shipping + minimum margin).`
          : ` accepted — at or above the $${floor.toFixed(2)} floor.`) +
        costNote,
      inputs,
    };
  }

  if (trustedComps && comps.medianSoldPrice !== null) {
    const price = styleTo99(Math.max(comps.medianSoldPrice, floor));
    const activeNote =
      comps.activeCount !== null
        ? ` ${comps.activeCount} active competing listing(s)${
            comps.medianActivePrice !== null
              ? ` asking ~$${comps.medianActivePrice.toFixed(2)} median`
              : ""
          }.`
        : "";
    return {
      price,
      floor,
      strategy: "comps",
      rationale:
        `Market-priced from ${comps.soldCount} sold comp(s), median $${comps.medianSoldPrice.toFixed(2)}, clamped to the $${floor.toFixed(2)} floor.` +
        activeNote +
        costNote,
      inputs,
    };
  }

  const sparseNote =
    comps !== null && !trustedComps
      ? ` Comps too sparse to trust (${comps.soldCount} sold < ${MIN_SOLD_COMPS}) — priced conservatively with lower confidence.`
      : "";
  const price = styleTo99(floor * d.markupOverFloor);
  return {
    price,
    floor,
    strategy: "floor_markup",
    rationale:
      `No trusted comps — priced at floor $${floor.toFixed(2)} × ${d.markupOverFloor} markup, styled to .99.` +
      sparseNote +
      costNote,
    inputs,
  };
}
