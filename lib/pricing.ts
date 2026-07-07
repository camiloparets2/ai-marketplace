// Pricing engine (docs/design/launch.md P0-3).
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
// Every decision is persisted to price_history with its rationale — the
// answer to "why did this list at $X?" is always one query away.
//
// ⚑ Defaults below are launch assumptions awaiting Camilo's confirmation —
// see the flag table in docs/design/launch.md.

import { getSupabaseAdmin } from "@/lib/connections";

export interface PricingDefaults {
  // eBay final value fee ≈ 13.6% + $0.40 for most categories.
  feeRate: number;
  feeFlat: number;
  // min_margin = max(flat, pct * price)  ⚑
  minMarginFlat: number;
  minMarginPct: number;
  // no-comps strategy: price = floor * markup, styled to .99  ⚑
  markupOverFloor: number;
}

export const PRICING_DEFAULTS: PricingDefaults = {
  feeRate: 0.136,
  feeFlat: 0.4,
  minMarginFlat: 3,
  minMarginPct: 0.15,
  markupOverFloor: 1.2,
};

export type PriceStrategy = "user_target" | "floor_markup";

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
  // A price the seller (or a comp source) asked for, if any.
  targetPrice: number | null;
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
  const floor = computeFloor(req.costBasis, req.shippingCost, d);
  const inputs: Record<string, number | null> = {
    costBasis: req.costBasis,
    shippingCost: req.shippingCost,
    targetPrice: req.targetPrice,
    feeRate: d.feeRate,
    feeFlat: d.feeFlat,
    minMarginFlat: d.minMarginFlat,
    minMarginPct: d.minMarginPct,
  };
  const costNote =
    req.costBasis === null
      ? " No cost basis recorded — floor assumes $0 cost; enter cost of goods for a real floor."
      : "";

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

  const price = styleTo99(floor * d.markupOverFloor);
  return {
    price,
    floor,
    strategy: "floor_markup",
    rationale:
      `No target or comps — priced at floor $${floor.toFixed(2)} × ${d.markupOverFloor} markup, styled to .99.` +
      costNote,
    inputs,
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function recordPriceDecision(
  userId: string,
  inventoryItemId: string,
  decision: PriceDecision
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("price_history").insert({
    user_id: userId,
    inventory_item_id: inventoryItemId,
    price: decision.price,
    floor_price: decision.floor,
    strategy: decision.strategy,
    rationale: decision.rationale,
    inputs: decision.inputs,
  });
  if (error) throw new Error(`price history insert failed: ${error.message}`);
}
