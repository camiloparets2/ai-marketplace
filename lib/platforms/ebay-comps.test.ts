// eBay comps engine (docs/design/comps-pricing.md): structured queries,
// Marketplace-Insights-denied fallback to Browse, grant detection, caching,
// and the band/demand/source math surfaced through summarizeComps.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchEbayComps,
  fetchEbayCompsFor,
  clearCompsCacheForTests,
  marketplaceInsightsStatus,
} from "./ebay-comps";
import type { CompsQuery } from "./ebay-comps";

const activeBody = {
  total: 7,
  itemSummaries: [
    { price: { value: "40.00" } },
    { price: { value: "50.00" } },
    { price: { value: "44.00" } },
    { price: { value: "60.00" } },
    { price: { value: "52.00" } },
  ],
};

const soldBody = {
  itemSales: Array.from({ length: 12 }, (_, i) => ({
    lastSoldPrice: { value: String(90 + i) },
  })),
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function deny(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

// Routes by URL, not call order — browse and insights fire concurrently.
function router(
  insights: () => Response,
  browse: () => Response
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL) =>
    String(url).includes("marketplace_insights") ? insights() : browse()
  );
}

const baseQuery: CompsQuery = {
  accessToken: "tok",
  brand: "Sony",
  categoryId: "112233",
  titleKeywords: "WH-1000XM4 wireless headphones",
  condition: "Very Good",
};

beforeEach(() => {
  clearCompsCacheForTests();
});

describe("fetchEbayCompsFor", () => {
  it("prefers TRUE SOLD comps and reports source, band, and demand", async () => {
    const fetchImpl = router(() => ok(soldBody), () => ok(activeBody));
    const comps = await fetchEbayCompsFor(baseQuery, fetchImpl as unknown as typeof fetch);
    expect(comps).toMatchObject({
      source: "sold",
      sampleSize: 12,
      demandSignal: "high", // ≥10 sold
      soldCount: 12,
      activeCount: 7,
    });
    // Band from the SOLD prices (90..101): p25 < median < p75.
    expect(comps?.lowPrice).toBeLessThan(comps?.medianPrice ?? 0);
    expect(comps?.highPrice).toBeGreaterThan(comps?.medianPrice ?? 0);
    expect(marketplaceInsightsStatus()).toBe("granted");
  });

  it("falls back to the Browse ACTIVE band when Insights is 403 — and remembers the denial", async () => {
    const fetchImpl = router(() => deny(403), () => ok(activeBody));
    const comps = await fetchEbayCompsFor(baseQuery, fetchImpl as unknown as typeof fetch);
    expect(comps).toMatchObject({
      source: "active",
      sampleSize: 5,
      // Active listings are supply, not demand — never above "low".
      demandSignal: "low",
      soldCount: 0,
      activeCount: 7,
      medianActivePrice: 50,
    });
    expect(marketplaceInsightsStatus()).toBe("denied");

    // Next lookup (different query → cache miss) skips the MI call entirely.
    fetchImpl.mockClear();
    await fetchEbayCompsFor(
      { ...baseQuery, titleKeywords: "different item" },
      fetchImpl as unknown as typeof fetch
    );
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("marketplace_insights"))).toBe(false);
  });

  it("sends the structured query: brand+keywords, leaf category, condition filter", async () => {
    const fetchImpl = router(() => deny(403), () => ok(activeBody));
    await fetchEbayCompsFor(baseQuery, fetchImpl as unknown as typeof fetch);
    const browseUrl = fetchImpl.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("item_summary"));
    expect(browseUrl).toContain("q=Sony+WH-1000XM4");
    expect(browseUrl).toContain("category_ids=112233");
    expect(browseUrl).toContain(encodeURIComponent("conditions:{USED}"));
  });

  it("caches per query — the second identical lookup makes zero network calls", async () => {
    const fetchImpl = router(() => ok(soldBody), () => ok(activeBody));
    await fetchEbayCompsFor(baseQuery, fetchImpl as unknown as typeof fetch);
    const callsAfterFirst = fetchImpl.mock.calls.length;
    const again = await fetchEbayCompsFor(baseQuery, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    expect(again?.source).toBe("sold");
  });

  it("returns null when everything fails — pricing then goes conservative", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const comps = await fetchEbayCompsFor(baseQuery, fetchImpl as unknown as typeof fetch);
    expect(comps).toBeNull();
  });

  it("legacy free-text wrapper still degrades to Browse-only on 403", async () => {
    const fetchImpl = router(() => deny(403), () => ok(activeBody));
    const comps = await fetchEbayComps(
      "tok",
      "sony headphones",
      fetchImpl as unknown as typeof fetch
    );
    expect(comps).toMatchObject({ source: "active", confidence: "low" });
  });
});
