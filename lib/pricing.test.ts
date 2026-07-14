import { describe, it, expect } from "vitest";
import {
  computeFloor,
  decidePrice,
  styleTo99,
  realizedProfit,
  PRICING_DEFAULTS,
} from "./pricing";

// Independent fee/margin recomputation to verify floors against — the
// exact buyer-paid-shipping model: the buyer's shipping payment cancels the
// label, and eBay's final value fee applies to the TOTAL (price + ship).
function netProfit(price: number, cost: number, ship: number): number {
  return (
    price +
    ship - // buyer pays shipping at checkout…
    ship - // …seller pays the label
    (PRICING_DEFAULTS.feeRate * (price + ship) + PRICING_DEFAULTS.feeFlat) -
    cost
  );
}
function requiredMargin(price: number): number {
  return Math.max(
    PRICING_DEFAULTS.minMarginFlat,
    PRICING_DEFAULTS.minMarginPct * price
  );
}

describe("computeFloor", () => {
  it("never lets the seller lose money at the floor", () => {
    const cases: Array<[number | null, number | null]> = [
      [10, 5],
      [0, 0],
      [null, 16.1],
      [250, 22.45],
    ];
    for (const [cost, ship] of cases) {
      const floor = computeFloor(cost, ship);
      expect(floor).not.toBeNull();
      expect(
        netProfit(floor as number, cost ?? 0, ship as number)
      ).toBeGreaterThanOrEqual(
        requiredMargin(floor as number) - 0.011 // cent rounding tolerance
      );
    }
  });

  it("charges only the FEE on shipping, not shipping itself (exact model)", () => {
    // Heavy-cheap regression (the SAKRETE 50 lb bag): the buyer pays the
    // $25 shipping at checkout, so the floor must carry only eBay's fee on
    // that shipping revenue — folding all $25 in priced the item ~a full
    // shipping cost above market.
    const floor = computeFloor(3.5, 25) as number;
    const feeOnShip = PRICING_DEFAULTS.feeRate * 25;
    // Exactly the flat-branch algebra with feeRate*ship, not ship:
    expect(floor).toBeCloseTo(
      (3.5 + feeOnShip + PRICING_DEFAULTS.feeFlat + PRICING_DEFAULTS.minMarginFlat) /
        (1 - PRICING_DEFAULTS.feeRate),
      1
    );
    // Sanity: the old model would have demanded ≥ $36; market for the bag
    // is ~$7-10, so the exact floor must land far below that.
    expect(floor).toBeLessThan(15);
    // …and the seller still clears the minimum margin at the floor.
    expect(netProfit(floor, 3.5, 25)).toBeGreaterThanOrEqual(
      requiredMargin(floor) - 0.011
    );
  });

  it("NEVER computes a floor with $0 shipping when shippingCost is null", () => {
    // The live money bug: 50 lb concrete, MANUAL_ESTIMATE_NEEDED shipping,
    // floor silently assumed free shipping. Unknown shipping = no floor.
    expect(computeFloor(3.5, null)).toBeNull();
    expect(computeFloor(null, null)).toBeNull();
    // and a KNOWN $0 shipping (genuinely free to ship) still computes
    expect(computeFloor(3.5, 0)).not.toBeNull();
  });

  it("uses the percent margin branch for expensive items", () => {
    // $250 cost: 15% of price dwarfs the $3 flat margin
    const floor = computeFloor(250, 10) as number;
    expect(PRICING_DEFAULTS.minMarginPct * floor).toBeGreaterThan(
      PRICING_DEFAULTS.minMarginFlat
    );
    expect(netProfit(floor, 250, 10)).toBeGreaterThanOrEqual(
      PRICING_DEFAULTS.minMarginPct * floor - 0.011
    );
  });

  it("uses the flat margin branch for cheap items", () => {
    const floor = computeFloor(2, 0) as number;
    // At this floor the binding constraint is the $3 flat margin
    expect(netProfit(floor, 2, 0)).toBeGreaterThanOrEqual(
      PRICING_DEFAULTS.minMarginFlat - 0.011
    );
  });
});

describe("decidePrice", () => {
  it("accepts a seller target at or above the floor", () => {
    const d = decidePrice({ costBasis: 10, shippingCost: 5, targetPrice: 49.99 });
    expect(d.strategy).toBe("user_target");
    expect(d.price).toBe(49.99);
    expect(d.rationale).toContain("accepted");
  });

  it("raises a below-floor target to the floor and says so", () => {
    const d = decidePrice({ costBasis: 50, shippingCost: 10, targetPrice: 20 });
    expect(d.price).toBe(d.floor);
    expect(d.price).toBeGreaterThan(20);
    expect(d.rationale).toContain("raised to the");
  });

  it("prices floor × markup with .99 styling when there is no target", () => {
    const d = decidePrice({ costBasis: 10, shippingCost: 5, targetPrice: null });
    expect(d.strategy).toBe("floor_markup");
    expect(d.floor).not.toBeNull();
    expect(d.price).toBeGreaterThanOrEqual(d.floor as number);
    expect(Math.round((d.price % 1) * 100)).toBe(99);
    expect(d.rationale).toContain("markup");
  });

  it("reports a null floor and a loud rationale when shipping is unknown", () => {
    const d = decidePrice({ costBasis: 10, shippingCost: null, targetPrice: null });
    expect(d.floor).toBeNull();
    expect(d.rationale).toMatch(/no shipping estimate/i);
    // the seed price never pretends to be a profitable floor
    expect(d.rationale).toMatch(/provisional|excludes shipping/i);
  });

  it("flags a missing cost basis in the rationale and inputs", () => {
    const d = decidePrice({ costBasis: null, shippingCost: null, targetPrice: null });
    expect(d.rationale).toContain("No cost basis");
    expect(d.inputs.costBasis).toBeNull();
  });
});

describe("realizedProfit — the books are built on the REAL sale price", () => {
  it("marketplace sale: sold − cost − fees on (price + shipping)", () => {
    // $8 mug, $3 cost, $10.40 shipping, sold on eBay:
    // fees = 0.136 * 18.40 + 0.40 = 2.9024 → profit ≈ 8 − 3 − 2.90
    const profit = realizedProfit(8, 3, 10.4, "ebay");
    expect(profit).toBeCloseTo(8 - 3 - (0.136 * 18.4 + 0.4), 2);
  });

  it("local/assisted sale (OfferUp): no marketplace fees, no shipping term", () => {
    expect(realizedProfit(8, 3, 10.4, "offerup")).toBe(5);
    expect(realizedProfit(8, 3, null, "facebook")).toBe(5);
  });

  it("a haggled-below-cost sale reports a LOSS, never clamped", () => {
    expect(realizedProfit(2, 3, null, "offerup")).toBe(-1);
  });

  it("unknown platform is treated fee-free (never invents fees)", () => {
    expect(realizedProfit(10, 4, null, "other")).toBe(6);
    expect(realizedProfit(10, 4, null, null)).toBe(6);
  });
});

describe("styleTo99", () => {
  it("rounds up to the next .99 without dipping below the input", () => {
    expect(styleTo99(24.3)).toBe(24.99);
    expect(styleTo99(24.99)).toBe(24.99);
    expect(styleTo99(24)).toBe(24.99);
    expect(styleTo99(0.5)).toBe(0.99);
  });
});
