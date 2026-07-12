import { describe, it, expect } from "vitest";
import {
  computeFloor,
  decidePrice,
  styleTo99,
  PRICING_DEFAULTS,
} from "./pricing";

// Independent fee/margin recomputation to verify floors against.
function netProfit(price: number, cost: number, ship: number): number {
  return (
    price -
    (PRICING_DEFAULTS.feeRate * price + PRICING_DEFAULTS.feeFlat) -
    ship -
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

describe("styleTo99", () => {
  it("rounds up to the next .99 without dipping below the input", () => {
    expect(styleTo99(24.3)).toBe(24.99);
    expect(styleTo99(24.99)).toBe(24.99);
    expect(styleTo99(24)).toBe(24.99);
    expect(styleTo99(0.5)).toBe(0.99);
  });
});
