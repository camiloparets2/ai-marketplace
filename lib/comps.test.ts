import { describe, it, expect } from "vitest";
import {
  median,
  extractSoldPrices,
  extractActivePrices,
  summarizeComps,
  percentile,
} from "./comps";
import { decidePrice } from "./pricing";

describe("median", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("payload extraction", () => {
  it("pulls sold prices tolerantly and drops junk", () => {
    expect(
      extractSoldPrices({
        itemSales: [
          { lastSoldPrice: { value: "45.00" } },
          { lastSoldPrice: { value: 52 } },
          { lastSoldPrice: { value: "not-a-number" } },
          {},
        ],
      })
    ).toEqual([45, 52]);
    expect(extractSoldPrices({})).toEqual([]);
    expect(extractSoldPrices(null)).toEqual([]);
  });

  it("pulls active listing count and prices", () => {
    const { total, prices } = extractActivePrices({
      total: 14,
      itemSummaries: [{ price: { value: "60.00" } }, { price: { value: "80.00" } }],
    });
    expect(total).toBe(14);
    expect(prices).toEqual([60, 80]);
  });
});

describe("percentile", () => {
  it("computes interpolated p25/p75 for the band", () => {
    expect(percentile([10, 20, 30, 40], 0.25)).toBe(17.5);
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(32.5);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.25)).toBe(7);
  });
});

describe("summarizeComps confidence", () => {
  it("is high with 3+ sold comps, low below", () => {
    expect(summarizeComps([10, 11, 12], { total: 5, prices: [] }).confidence).toBe(
      "high"
    );
    expect(summarizeComps([10, 11], { total: 5, prices: [] }).confidence).toBe(
      "low"
    );
  });
});

describe("decidePrice with comps", () => {
  const comps = {
    medianPrice: 100,
    lowPrice: 90,
    highPrice: 115,
    sampleSize: 8,
    demandSignal: "medium" as const,
    source: "sold" as const,
    medianSoldPrice: 100,
    soldCount: 8,
    activeCount: 12,
    medianActivePrice: 110,
    confidence: "high" as const,
  };

  it("prices from the sold median, clamped to the floor, with rationale", () => {
    const d = decidePrice({
      costBasis: 20,
      shippingCost: 10,
      targetPrice: null,
      comps,
    });
    expect(d.strategy).toBe("comps");
    expect(d.floor).not.toBeNull();
    expect(d.price).toBeGreaterThanOrEqual(d.floor as number);
    expect(d.price).toBeGreaterThanOrEqual(100);
    expect(d.rationale).toContain("8 sold comp(s)");
    expect(d.inputs.compsMedianSold).toBe(100);
  });

  it("assumes cost from the comp median when no cost basis was entered", () => {
    const d = decidePrice({
      costBasis: null,
      shippingCost: 10,
      targetPrice: null,
      comps,
    });
    expect(d.inputs.assumedCost).toBe(30); // 30% of $100 ⚑
    expect(d.rationale).toContain("assumed $30.00");
  });

  it("ignores sparse comps and says so with lower confidence", () => {
    const d = decidePrice({
      costBasis: 20,
      shippingCost: 10,
      targetPrice: null,
      comps: {
        ...comps,
        soldCount: 2,
        sampleSize: 2,
        source: "sold" as const,
        confidence: "low" as const,
      },
    });
    expect(d.strategy).toBe("floor_markup");
    expect(d.rationale).toContain("too sparse");
  });

  it("a seller target still beats comps", () => {
    const d = decidePrice({
      costBasis: 20,
      shippingCost: 10,
      targetPrice: 150,
      comps,
    });
    expect(d.strategy).toBe("user_target");
    expect(d.price).toBe(150);
  });
});

describe("decidePrice comps anchoring (docs/design/comps-pricing.md)", () => {
  const soldComps = {
    medianPrice: 100,
    lowPrice: 90,
    highPrice: 115,
    sampleSize: 8,
    demandSignal: "medium" as const,
    source: "sold" as const,
    fetchedAt: "2026-07-12T00:00:00.000Z",
    medianSoldPrice: 100,
    soldCount: 8,
    activeCount: 12,
    medianActivePrice: 110,
    confidence: "high" as const,
  };

  it("adjusts the anchor down for condition and defects, never below floor", () => {
    const d = decidePrice({
      costBasis: 20,
      shippingCost: 10,
      targetPrice: null,
      comps: soldComps,
      condition: "Good", // ⚑ factor 0.88
      defectCount: 2, // −6%
    });
    expect(d.strategy).toBe("comps");
    expect(d.grounded).toBe(true);
    // 100 × 0.88 × 0.94 = 82.72 → styled ≥ floor
    expect(d.inputs.compsAdjustedAnchor).toBe(82.72);
    expect(d.price).toBeGreaterThanOrEqual(d.floor as number);
    expect(d.rationale).toContain("Adjusted for Good, 2 defect(s)");
    // Snapshot persisted for the price_history audit row.
    expect(d.inputs).toMatchObject({
      compsMedian: 100,
      compsLow: 90,
      compsHigh: 115,
      compsSampleSize: 8,
      compsSource: "sold",
      compsDemand: "medium",
      compsFetchedAt: "2026-07-12T00:00:00.000Z",
    });
  });

  it("anchors from an ACTIVE band (MI not granted) with the caution note", () => {
    const d = decidePrice({
      costBasis: 20,
      shippingCost: 10,
      targetPrice: null,
      comps: {
        ...soldComps,
        source: "active" as const,
        sampleSize: 6,
        demandSignal: "low" as const,
        medianSoldPrice: null,
        soldCount: 0,
      },
    });
    expect(d.strategy).toBe("comps");
    expect(d.rationale).toContain("ACTIVE listing(s)");
    expect(d.rationale).toContain("Marketplace Insights");
  });

  it("keeps the AI estimate when comps are sparse — UNGROUNDED, held for review", () => {
    const d = decidePrice({
      costBasis: 20,
      shippingCost: 10,
      targetPrice: null,
      comps: { ...soldComps, sampleSize: 2, soldCount: 2 },
      aiSuggestedPrice: 75,
    });
    expect(d.strategy).toBe("ai_estimate");
    expect(d.grounded).toBe(false);
    expect(d.price).toBeGreaterThanOrEqual(Math.max(75, d.floor as number));
    expect(d.rationale).toMatch(/NOT grounded/i);
    // The guardrail consumes `grounded` — ungrounded never auto-publishes
    // (see lib/guardrails.test.ts priceGroundedGate).
  });

  it("an ungrounded AI estimate below the floor is raised to it", () => {
    const d = decidePrice({
      costBasis: 50,
      shippingCost: 20,
      targetPrice: null,
      comps: null,
      aiSuggestedPrice: 6.5, // the concrete-bag guess
    });
    expect(d.strategy).toBe("ai_estimate");
    expect(d.grounded).toBe(false);
    expect(d.price).toBe(d.floor); // never a $6.50 loss-maker again
  });
});
