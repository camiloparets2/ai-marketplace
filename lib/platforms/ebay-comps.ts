// eBay comps engine (docs/design/comps-pricing.md) — the network layer over
// lib/comps.ts's pure math. OFFICIAL APIs ONLY:
//
//   - SOLD comps: Buy Marketplace Insights `item_sales/search`. LIMITED
//     RELEASE — a keyset without the grant gets 401/403. That is detected,
//     remembered for an hour (no hammering), and NEVER fails the flow.
//   - ACTIVE listings: Buy Browse `item_summary/search` — generally
//     available; the fallback band (source: "active") plus competition count.
//
// Structured queries (brand + leaf category + condition) beat free-text
// title search for comp quality; results are cached briefly per query to
// respect rate limits.

import { LRUCache } from "lru-cache";
import {
  extractSoldPrices,
  extractActivePrices,
  summarizeComps,
} from "@/lib/comps";
import type { CompsSummary } from "@/lib/comps";
import type { ListingInput } from "@/lib/platforms/types";

export interface CompsQuery {
  accessToken: string;
  // Structured hints — each null is simply omitted from the eBay query.
  brand: string | null;
  // LEAF category id when known (from the readiness/category resolution work).
  categoryId: string | null;
  titleKeywords: string;
  condition: ListingInput["condition"] | null;
  marketplaceId?: string; // default EBAY_US
}

// ── Marketplace Insights grant detection ─────────────────────────────────────

export type MarketplaceInsightsStatus = "granted" | "denied" | "unknown";

const MI_RECHECK_MS = 60 * 60 * 1000; // remember a denial for 1h
let miStatus: MarketplaceInsightsStatus = "unknown";
let miDeniedAt = 0;

/** Whether this keyset has the (limited-release) Marketplace Insights grant,
 *  as last observed at runtime. "denied" → Camilo must APPLY for access in
 *  the eBay developer portal; the fallback band comes from active listings. */
export function marketplaceInsightsStatus(): MarketplaceInsightsStatus {
  return miStatus;
}

function shouldTryInsights(): boolean {
  if (miStatus !== "denied") return true;
  return Date.now() - miDeniedAt > MI_RECHECK_MS;
}

// ── Cache (rate-limit respect) ───────────────────────────────────────────────

const COMPS_CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new LRUCache<string, { summary: CompsSummary | null }>({
  max: 500,
  ttl: COMPS_CACHE_TTL_MS,
});

export function clearCompsCacheForTests(): void {
  cache.clear();
  miStatus = "unknown";
  miDeniedAt = 0;
}

function cacheKey(q: CompsQuery): string {
  return [
    q.marketplaceId ?? "EBAY_US",
    (q.brand ?? "").toLowerCase(),
    q.categoryId ?? "",
    q.condition ?? "",
    q.titleKeywords.toLowerCase().slice(0, 80),
  ].join("|");
}

// ── Query building ───────────────────────────────────────────────────────────

// Browse condition filter values; sold comps can't filter condition, so the
// pricing engine applies a condition ADJUSTMENT instead (pricing-core).
function browseConditionFilter(
  condition: ListingInput["condition"] | null
): string | null {
  if (condition === null) return null;
  return condition === "New" ? "conditions:{NEW}" : "conditions:{USED}";
}

function buildQ(q: CompsQuery): string {
  // "Unbranded" adds noise, not signal, to a search query.
  const brand = q.brand && q.brand !== "Unbranded" ? q.brand : "";
  const combined = `${brand} ${q.titleKeywords}`.trim().replace(/\s+/g, " ");
  return combined.slice(0, 100);
}

function searchParams(q: CompsQuery, forBrowse: boolean): string {
  const params = new URLSearchParams({ q: buildQ(q), limit: "50" });
  if (q.categoryId) params.set("category_ids", q.categoryId);
  if (forBrowse) {
    const cond = browseConditionFilter(q.condition);
    if (cond) params.set("filter", cond);
  }
  return params.toString();
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function apiBase(): string {
  const production =
    (process.env.EBAY_ENV ?? "PRODUCTION").toUpperCase() !== "SANDBOX";
  return production ? "https://api.ebay.com" : "https://api.sandbox.ebay.com";
}

/**
 * Comparable listings for {brand, leaf category, keywords, condition}.
 * Prefers TRUE SOLD comps (Marketplace Insights); a not-granted keyset
 * falls back to the Browse active-listings band with source:"active".
 * Every failure degrades to null — comps are advisory, never load-bearing
 * for availability. Results cached per query for 10 minutes.
 */
export async function fetchEbayCompsFor(
  q: CompsQuery,
  fetchImpl: typeof fetch = fetch
): Promise<CompsSummary | null> {
  const key = cacheKey(q);
  const cached = cache.get(key);
  if (cached !== undefined) return cached.summary;

  const headers = {
    Authorization: `Bearer ${q.accessToken}`,
    "X-EBAY-C-MARKETPLACE-ID": q.marketplaceId ?? "EBAY_US",
  };

  try {
    const browsePromise = fetchImpl(
      `${apiBase()}/buy/browse/v1/item_summary/search?${searchParams(q, true)}`,
      { headers }
    );
    let soldPrices: number[] = [];
    if (shouldTryInsights()) {
      const salesRes = await fetchImpl(
        `${apiBase()}/buy/marketplace_insights/v1_beta/item_sales/search?${searchParams(q, false)}`,
        { headers }
      );
      if (salesRes.ok) {
        miStatus = "granted";
        soldPrices = extractSoldPrices(await salesRes.json());
      } else if (salesRes.status === 401 || salesRes.status === 403) {
        // Limited-release API without the grant — remember and fall back.
        miStatus = "denied";
        miDeniedAt = Date.now();
      }
      // Other MI errors: transient — fall back this call, retry next time.
    }

    const browseRes = await browsePromise;
    const active = browseRes.ok
      ? extractActivePrices(await browseRes.json())
      : { total: null, prices: [] };

    const summary =
      soldPrices.length === 0 && active.prices.length === 0
        ? null
        : summarizeComps(soldPrices, active);
    cache.set(key, { summary });
    return summary;
  } catch (err) {
    console.warn("[ebay-comps] lookup failed — pricing falls back:", err);
    return null;
  }
}

/** Legacy free-text lookup (title only) — existing callers; prefer
 *  fetchEbayCompsFor with structured hints. */
export async function fetchEbayComps(
  accessToken: string,
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<CompsSummary | null> {
  return fetchEbayCompsFor(
    {
      accessToken,
      brand: null,
      categoryId: null,
      titleKeywords: query,
      condition: null,
    },
    fetchImpl
  );
}
