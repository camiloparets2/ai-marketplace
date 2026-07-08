// Pricing comps from eBay (docs/design/launch.md P1-3).
//
// Two sources, both optional:
//   - SOLD comps: Marketplace Insights API (item_sales/search). LIMITED
//     RELEASE — most keysets get 403 until eBay grants access. That's fine:
//     every failure here degrades to null and the pricing engine falls back
//     to conservative floor-markup pricing with a lowered-confidence note.
//   - ACTIVE listings: Browse API (item_summary/search) — generally
//     available; used for competition count and asking-price context.
//
// The caller supplies an OAuth access token (the seller's stored eBay
// connection token works for both APIs). No token minting happens here.

export interface CompsSummary {
  medianSoldPrice: number | null;
  soldCount: number;
  activeCount: number | null;
  medianActivePrice: number | null;
  // 'high' needs enough sold comps to trust; anything else is 'low'.
  confidence: "high" | "low";
}

// Fewer sold comps than this → comps are ignored for pricing (too noisy). ⚑
export const MIN_SOLD_COMPS = 3;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Tolerant payload extraction (pure, tested) ───────────────────────────────

interface Moneyish {
  value?: string | number;
}

interface SalesPayload {
  itemSales?: Array<{ lastSoldPrice?: Moneyish; totalSoldQuantity?: number }>;
}

interface BrowsePayload {
  total?: number;
  itemSummaries?: Array<{ price?: Moneyish }>;
}

function moneyValue(m: Moneyish | undefined): number | null {
  if (!m || m.value === undefined) return null;
  const n = Number(m.value);
  return isFinite(n) && n > 0 ? n : null;
}

export function extractSoldPrices(payload: unknown): number[] {
  const sales = (payload as SalesPayload)?.itemSales;
  if (!Array.isArray(sales)) return [];
  return sales
    .map((s) => moneyValue(s.lastSoldPrice))
    .filter((n): n is number => n !== null);
}

export function extractActivePrices(payload: unknown): {
  total: number | null;
  prices: number[];
} {
  const body = payload as BrowsePayload;
  const prices = Array.isArray(body?.itemSummaries)
    ? body.itemSummaries
        .map((s) => moneyValue(s.price))
        .filter((n): n is number => n !== null)
    : [];
  return { total: typeof body?.total === "number" ? body.total : null, prices };
}

export function summarizeComps(
  soldPrices: number[],
  active: { total: number | null; prices: number[] }
): CompsSummary {
  return {
    medianSoldPrice: median(soldPrices),
    soldCount: soldPrices.length,
    activeCount: active.total,
    medianActivePrice: median(active.prices),
    confidence: soldPrices.length >= MIN_SOLD_COMPS ? "high" : "low",
  };
}

// ─── Fetch (network; every failure → null) ────────────────────────────────────

function apiBase(): string {
  const production =
    (process.env.EBAY_ENV ?? "PRODUCTION").toUpperCase() !== "SANDBOX";
  return production ? "https://api.ebay.com" : "https://api.sandbox.ebay.com";
}

export async function fetchEbayComps(
  accessToken: string,
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<CompsSummary | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
  };
  const q = encodeURIComponent(query.slice(0, 100));

  try {
    const [salesRes, browseRes] = await Promise.all([
      fetchImpl(
        `${apiBase()}/buy/marketplace_insights/v1_beta/item_sales/search?q=${q}&limit=50`,
        { headers }
      ),
      fetchImpl(
        `${apiBase()}/buy/browse/v1/item_summary/search?q=${q}&limit=50`,
        { headers }
      ),
    ]);

    // Insights is limited-release: 403/404 just means "no sold comps for us".
    const soldPrices = salesRes.ok ? extractSoldPrices(await salesRes.json()) : [];
    const active = browseRes.ok
      ? extractActivePrices(await browseRes.json())
      : { total: null, prices: [] };

    if (soldPrices.length === 0 && active.prices.length === 0) return null;
    return summarizeComps(soldPrices, active);
  } catch (err) {
    console.warn("[comps] lookup failed — pricing falls back:", err);
    return null;
  }
}
