// Order sync — detects sales that happened ON eBay/Etsy and routes them
// through markItemSold, which already handles cross-channel delisting.
// This closes the oversell window the manual "Mark sold" button left open.
//
// Trigger paths:
//   - Vercel Cron → POST /api/sync/orders with the CRON_SECRET (all users)
//   - opportunistic: loading /api/inventory syncs the viewer (throttled)
//   - manual: the "Check for new sales" button on /inventory
//
// Safety: markItemSold is idempotent and the query window overlaps the last
// sync generously, so double-processing a sale is a harmless no-op.

import { getSupabaseAdmin, getConnection } from "@/lib/connections";
import { fetchEbaySales } from "@/lib/platforms/ebay";
import { fetchEtsySales } from "@/lib/platforms/etsy";
import { fetchShopifySales } from "@/lib/platforms/shopify";
import { markItemSold } from "@/lib/inventory";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";

// Re-scan this far behind the last sync to absorb clock skew, webhook lag,
// and orders that flip to PAID late.
const OVERLAP_MS = 24 * 60 * 60 * 1000;
// First-ever sync looks back this far.
const INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Opportunistic syncs (inventory page loads) at most this often.
export const OPPORTUNISTIC_MIN_INTERVAL_MS = 10 * 60 * 1000;

// ─── Pure matching (unit tested) ──────────────────────────────────────────────

export interface SaleKey {
  listingId: string | null;
  sku: string | null;
  price: number | null;
}

export interface OpenListing {
  inventoryItemId: string;
  externalId: string | null;
  sku: string | null;
  status: "live" | "ended" | "end_failed";
}

export interface SaleMatch {
  inventoryItemId: string;
  price: number | null;
}

// Match platform sales to our open listings by external id, falling back to
// SKU (eBay). Each inventory item matches at most once per pass.
export function matchSales(
  sales: SaleKey[],
  listings: OpenListing[]
): SaleMatch[] {
  const matches: SaleMatch[] = [];
  const taken = new Set<string>();

  for (const sale of sales) {
    const hit = listings.find(
      (l) =>
        !taken.has(l.inventoryItemId) &&
        l.status !== "ended" &&
        ((sale.listingId !== null && l.externalId === sale.listingId) ||
          (sale.sku !== null && l.sku !== null && l.sku === sale.sku))
    );
    if (hit) {
      taken.add(hit.inventoryItemId);
      matches.push({ inventoryItemId: hit.inventoryItemId, price: sale.price });
    }
  }
  return matches;
}

// ─── Sync state ───────────────────────────────────────────────────────────────

async function lastSyncedAt(
  userId: string,
  platform: ApiPlatform
): Promise<Date | null> {
  const { data } = await getSupabaseAdmin()
    .from("sync_state")
    .select("last_synced_at")
    .eq("user_id", userId)
    .eq("platform", platform)
    .maybeSingle<{ last_synced_at: string }>();
  return data ? new Date(data.last_synced_at) : null;
}

async function stampSynced(userId: string, platform: ApiPlatform): Promise<void> {
  await getSupabaseAdmin().from("sync_state").upsert({
    user_id: userId,
    platform,
    last_synced_at: new Date().toISOString(),
  });
}

export async function lastAnySyncAt(userId: string): Promise<Date | null> {
  const { data } = await getSupabaseAdmin()
    .from("sync_state")
    .select("last_synced_at")
    .eq("user_id", userId)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ last_synced_at: string }>();
  return data ? new Date(data.last_synced_at) : null;
}

// ─── Per-user sync ────────────────────────────────────────────────────────────

export interface SyncSummary {
  platform: ApiPlatform;
  salesSeen: number;
  itemsSold: number;
  error?: string;
}

async function openListingsFor(
  userId: string,
  platform: ApiPlatform
): Promise<OpenListing[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("marketplace_listings")
    .select("inventory_item_id, external_id, meta, status")
    .eq("user_id", userId)
    .eq("platform", platform)
    .neq("status", "ended");
  if (error) throw new Error(`open listings read failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    inventoryItemId: row.inventory_item_id as string,
    externalId: (row.external_id as string | null) ?? null,
    sku: ((row.meta as Record<string, string>) ?? {}).sku ?? null,
    status: row.status as OpenListing["status"],
  }));
}

async function syncPlatform(
  userId: string,
  platform: ApiPlatform
): Promise<SyncSummary> {
  try {
    const conn = await getConnection(userId, platform);
    if (!conn) return { platform, salesSeen: 0, itemsSold: 0 };

    const listings = await openListingsFor(userId, platform);
    if (listings.length === 0) {
      await stampSynced(userId, platform);
      return { platform, salesSeen: 0, itemsSold: 0 };
    }

    const last = await lastSyncedAt(userId, platform);
    const since = new Date(
      (last ? last.getTime() - OVERLAP_MS : Date.now() - INITIAL_LOOKBACK_MS)
    );

    const sales: SaleKey[] =
      platform === "ebay"
        ? await fetchEbaySales(conn, since.toISOString())
        : platform === "shopify"
          ? (await fetchShopifySales(conn, since.toISOString())).map((s) => ({
              listingId: s.productId,
              sku: null,
              price: s.price,
            }))
          : (await fetchEtsySales(conn, Math.floor(since.getTime() / 1000))).map(
              (s) => ({ listingId: s.listingId, sku: null, price: s.price })
            );

    const matches = matchSales(sales, listings);
    for (const match of matches) {
      await markItemSold(userId, match.inventoryItemId, platform, match.price);
    }

    await stampSynced(userId, platform);
    return { platform, salesSeen: sales.length, itemsSold: matches.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync failed";
    console.error(`[order-sync] ${platform} sync failed for ${userId}:`, message);
    return { platform, salesSeen: 0, itemsSold: 0, error: message };
  }
}

export async function syncUserSales(userId: string): Promise<SyncSummary[]> {
  const results: SyncSummary[] = [];
  for (const platform of API_PLATFORMS) {
    results.push(await syncPlatform(userId, platform));
  }
  return results;
}

// ─── Fleet sync (cron) ────────────────────────────────────────────────────────

export async function syncAllUsers(): Promise<{ users: number; itemsSold: number }> {
  const { data, error } = await getSupabaseAdmin()
    .from("platform_connections")
    .select("user_id");
  if (error) throw new Error(`connection scan failed: ${error.message}`);

  const userIds = [...new Set((data ?? []).map((r) => r.user_id as string))];
  let itemsSold = 0;
  for (const userId of userIds) {
    const summaries = await syncUserSales(userId);
    itemsSold += summaries.reduce((n, s) => n + s.itemsSold, 0);
  }
  return { users: userIds.length, itemsSold };
}
