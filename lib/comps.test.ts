import { describe, it, expect, vi } from "vitest";
import {
  median,
  extractSoldPrices,
  extractActivePrices,
  summarizeComps,
  fetchEbayComps,
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

describe("fetchEbayComps fallback behavior", () => {
  const activeBody = {
    total: 7,
    itemSummaries: [{ price: { value: "50.00" } }],
  };

  it("degrades to Browse-only when Marketplace Insights is 403 (limited release)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 }) // insights
      .mockResolvedValueOnce({ ok: true, json: async () => activeBody }); // browse
    const comps = await fetchEbayComps("tok", "sony headphones", fetchImpl as unknown as typeof fetch);
    expect(comps).toMatchObject({
      soldCount: 0,
      confidence: "low",
      activeCount: 7,
      medianActivePrice: 50,
    });
  });

  it("returns null when everything fails — pricing then goes conservative", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const comps = await fetchEbayComps("tok", "q", fetchImpl as unknown as typeof fetch);
    expect(comps).toBeNull();
  });
});

describe("decidePrice with comps", () => {
  const comps = {
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
      comps: { ...comps, soldCount: 2, confidence: "low" },
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
