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

export interface CompsSummary {
  // ── Unified market band (docs/design/comps-pricing.md) ──
  // Anchor price: SOLD median when sold data exists, else the active median.
  medianPrice: number | null;
  // 25th–75th percentile of the source prices — robust to the one $1
  // parts-only listing and the one $999 fantasy ask.
  lowPrice: number | null;
  highPrice: number | null;
  // How many prices the band was computed from (of the anchoring source).
  sampleSize: number;
  // Demand is only measurable from SOLD velocity: sold ≥10 → high, ≥3 →
  // medium, else low. Active-only data is supply, not demand → always
  // "low" (pretending otherwise is the $6.50-concrete mistake again). ⚑
  demandSignal: "high" | "medium" | "low";
  // Which API grounded the band: Marketplace Insights sold comps, or the
  // Browse-API active-listings fallback (MI is limited-release).
  source: "sold" | "active";
  // When the band was fetched (set by the network layer) — persisted with
  // the price decision for audit.
  fetchedAt?: string;

  // ── Legacy fields (existing consumers) ──
  medianSoldPrice: number | null;
  soldCount: number;
  activeCount: number | null;
  medianActivePrice: number | null;
  // 'high' needs enough sold comps to trust; anything else is 'low'.
  confidence: "high" | "low";
}

// Fewer sold comps than this → sold comps are ignored for pricing (too noisy). ⚑
export const MIN_SOLD_COMPS = 3;
// With no MI grant, an active-listings band needs at least this many prices
// to anchor a price (with demand "low" + a caution note). ⚑
export const MIN_ACTIVE_COMPS = 5;
// Sold velocity thresholds for the demand signal. ⚑
export const HIGH_DEMAND_SOLD = 10;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Linear-interpolated percentile (p in 0–1) — the band uses p25/p75.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
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
  // SOLD prices anchor whenever any exist; the Browse active band is the
  // fallback for keysets without the Marketplace Insights grant.
  const source: CompsSummary["source"] = soldPrices.length > 0 ? "sold" : "active";
  const bandPrices = source === "sold" ? soldPrices : active.prices;
  const demandSignal: CompsSummary["demandSignal"] =
    source === "sold"
      ? soldPrices.length >= HIGH_DEMAND_SOLD
        ? "high"
        : soldPrices.length >= MIN_SOLD_COMPS
          ? "medium"
          : "low"
      : "low";
  const round2 = (n: number | null): number | null =>
    n === null ? null : Math.round(n * 100) / 100;
  return {
    medianPrice: round2(median(bandPrices)),
    lowPrice: round2(percentile(bandPrices, 0.25)),
    highPrice: round2(percentile(bandPrices, 0.75)),
    sampleSize: bandPrices.length,
    demandSignal,
    source,
    medianSoldPrice: median(soldPrices),
    soldCount: soldPrices.length,
    activeCount: active.total,
    medianActivePrice: median(active.prices),
    confidence: soldPrices.length >= MIN_SOLD_COMPS ? "high" : "low",
  };
}

/** A band trustworthy enough to ANCHOR a price: enough sold comps, or —
 *  when MI isn't granted — a wide-enough active band (demand stays "low"
 *  and the rationale carries a caution note). ⚑ */
export function compsTrusted(comps: CompsSummary | null): comps is CompsSummary {
  if (comps === null || comps.medianPrice === null) return false;
  return comps.source === "sold"
    ? comps.sampleSize >= MIN_SOLD_COMPS
    : comps.sampleSize >= MIN_ACTIVE_COMPS;
}

// The network layer lives in lib/platforms/ebay-comps.ts (structured
// queries, caching, Marketplace Insights grant detection). This module
// stays pure and client-safe — PricingPanel imports the type from here.
