// Inventory as source of truth (server-only).
//
// Every user publish creates an inventory item; every live marketplace
// listing points back to it. Selling or delisting an item ends its listings
// on every other channel — the "never oversell" promise. Decisions about
// WHICH listings to end live in lib/inventory-rules.ts (pure, tested);
// this module executes them against eBay/Etsy/Stripe.

import { getSupabaseAdmin, getConnection } from "@/lib/connections";
import { endEbayListing } from "@/lib/platforms/ebay";
import { endEtsyListing } from "@/lib/platforms/etsy";
import { endShopifyListing } from "@/lib/platforms/shopify";
import { deactivatePaymentLink } from "@/lib/stripe-link";
import { planEndListings } from "@/lib/inventory-rules";
import type { ListingInput } from "@/lib/platforms/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ListingChannel = "ebay" | "etsy" | "shopify" | "direct";

export interface LiveListing {
  platform: ListingChannel;
  url: string;
  externalId: string;
  meta: Record<string, string>;
}

export interface ListingRow {
  id: string;
  platform: string;
  external_id: string | null;
  url: string | null;
  meta: Record<string, string>;
  status: "live" | "ended" | "end_failed";
  last_error: string | null;
}

export interface InventoryItemRow {
  id: string;
  title: string;
  condition: string;
  photo_url: string | null;
  quantity: number;
  price: number;
  status: "draft" | "listed" | "sold" | "archived";
  sold_at: string | null;
  sold_price: number | null;
  sold_platform: string | null;
  created_at: string;
  listings: ListingRow[];
}

export interface EndResult {
  platform: string;
  ok: boolean;
  error?: string;
}

// ─── Creation (called from the publish fan-out) ───────────────────────────────

export async function createInventoryItem(
  userId: string,
  listing: ListingInput,
  photoUrl: string | null
): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .insert({
      user_id: userId,
      title: listing.title,
      brand: listing.brand,
      model: listing.model,
      upc: listing.upc,
      condition: listing.condition,
      category: listing.category,
      specs: listing.specs,
      photo_url: photoUrl,
      price: listing.price,
    })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(`inventory item insert failed: ${error.message}`);
  return data.id;
}

export async function recordLiveListing(
  userId: string,
  inventoryItemId: string,
  listing: LiveListing,
  price: number
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("marketplace_listings").insert({
    inventory_item_id: inventoryItemId,
    user_id: userId,
    platform: listing.platform,
    external_id: listing.externalId,
    url: listing.url,
    meta: listing.meta,
    status: "live",
    price,
  });
  if (error) throw new Error(`listing record failed: ${error.message}`);
}

export async function recordPublishAttempt(
  userId: string,
  inventoryItemId: string | null,
  platform: string,
  status: "live" | "assist" | "not_connected" | "error",
  errorMessage?: string
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("publish_attempts").insert({
    user_id: userId,
    inventory_item_id: inventoryItemId,
    platform,
    status,
    error: errorMessage ?? null,
  });
  if (error) console.error("[inventory] attempt log failed:", error.message);
}

export async function markItemListed(inventoryItemId: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({ status: "listed", updated_at: new Date().toISOString() })
    .eq("id", inventoryItemId)
    .eq("status", "draft");
  if (error) console.error("[inventory] mark listed failed:", error.message);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listInventory(userId: string): Promise<InventoryItemRow[]> {
  const supabase = getSupabaseAdmin();

  const { data: items, error } = await supabase
    .from("inventory_items")
    .select(
      "id, title, condition, photo_url, quantity, price, status, sold_at, sold_price, sold_platform, created_at"
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`inventory read failed: ${error.message}`);
  if (!items || items.length === 0) return [];

  const { data: listings, error: listingsError } = await supabase
    .from("marketplace_listings")
    .select("id, inventory_item_id, platform, external_id, url, meta, status, last_error")
    .in(
      "inventory_item_id",
      items.map((i) => i.id)
    );
  if (listingsError) {
    throw new Error(`listings read failed: ${listingsError.message}`);
  }

  const byItem = new Map<string, ListingRow[]>();
  for (const l of listings ?? []) {
    const key = l.inventory_item_id as string;
    const rows = byItem.get(key) ?? [];
    rows.push(l as unknown as ListingRow);
    byItem.set(key, rows);
  }

  return items.map((item) => ({
    ...(item as Omit<InventoryItemRow, "listings">),
    listings: byItem.get(item.id) ?? [],
  }));
}

// ─── Sold / delist sync — the anti-oversell core ──────────────────────────────

async function endOneListing(userId: string, listing: ListingRow): Promise<void> {
  if (listing.platform === "direct") {
    if (!listing.external_id) throw new Error("missing payment link id");
    await deactivatePaymentLink(listing.external_id);
    return;
  }
  if (listing.platform === "ebay") {
    const conn = await getConnection(userId, "ebay");
    if (!conn) throw new Error("eBay is not connected — reconnect and retry");
    const offerId = listing.meta.offerId;
    if (!offerId) throw new Error("missing eBay offer id");
    await endEbayListing(conn, offerId);
    return;
  }
  if (listing.platform === "etsy") {
    const conn = await getConnection(userId, "etsy");
    if (!conn) throw new Error("Etsy is not connected — reconnect and retry");
    const shopId = listing.meta.shopId;
    if (!shopId || !listing.external_id) throw new Error("missing Etsy ids");
    await endEtsyListing(conn, shopId, listing.external_id);
    return;
  }
  if (listing.platform === "shopify") {
    const conn = await getConnection(userId, "shopify");
    if (!conn) throw new Error("Shopify is not connected — reconnect and retry");
    if (!listing.external_id) throw new Error("missing Shopify product id");
    await endShopifyListing(conn, listing.external_id);
    return;
  }
  throw new Error(`unknown platform: ${listing.platform}`);
}

async function endListings(
  userId: string,
  listings: ListingRow[],
  soldPlatform: string | null
): Promise<EndResult[]> {
  const supabase = getSupabaseAdmin();
  const plan = planEndListings(listings, soldPlatform);
  const results: EndResult[] = [];

  // The sold platform's own listing was ended by the platform — record that.
  for (const listing of plan.alreadyEnded.filter((l) => l.status !== "ended")) {
    await supabase
      .from("marketplace_listings")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", listing.id);
  }

  await Promise.all(
    plan.toEnd.map(async (ref) => {
      const listing = listings.find((l) => l.id === ref.id);
      if (!listing) return;
      try {
        await endOneListing(userId, listing);
        await supabase
          .from("marketplace_listings")
          .update({
            status: "ended",
            ended_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", listing.id);
        results.push({ platform: listing.platform, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "end failed";
        // end_failed keeps it in the retry set for the next sold/delist call.
        await supabase
          .from("marketplace_listings")
          .update({ status: "end_failed", last_error: message })
          .eq("id", listing.id);
        results.push({ platform: listing.platform, ok: false, error: message });
      }
    })
  );

  return results;
}

async function getItemWithListings(
  userId: string,
  itemId: string
): Promise<{ status: string; listings: ListingRow[] } | null> {
  const supabase = getSupabaseAdmin();
  const { data: item } = await supabase
    .from("inventory_items")
    .select("id, status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle<{ id: string; status: string }>();
  if (!item) return null;

  const { data: listings } = await supabase
    .from("marketplace_listings")
    .select("id, platform, external_id, url, meta, status, last_error")
    .eq("inventory_item_id", itemId);
  return { status: item.status, listings: (listings ?? []) as unknown as ListingRow[] };
}

/**
 * Mark an item sold and end its listings everywhere else.
 * Idempotent: re-running retries any listing whose end previously failed.
 */
export async function markItemSold(
  userId: string,
  itemId: string,
  soldPlatform: string,
  soldPrice: number | null
): Promise<{ ok: boolean; endResults: EndResult[] } | null> {
  const item = await getItemWithListings(userId, itemId);
  if (!item) return null;

  const supabase = getSupabaseAdmin();
  // Only stamp sale facts on the first call — retries just re-run the ends.
  if (item.status !== "sold") {
    const { error } = await supabase
      .from("inventory_items")
      .update({
        status: "sold",
        quantity: 0,
        sold_at: new Date().toISOString(),
        sold_price: soldPrice,
        sold_platform: soldPlatform,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId)
      .eq("user_id", userId);
    if (error) throw new Error(`mark sold failed: ${error.message}`);
  }

  const endResults = await endListings(userId, item.listings, soldPlatform);
  return { ok: endResults.every((r) => r.ok), endResults };
}

/** End all listings without a sale (pull the item back to draft). */
export async function delistItem(
  userId: string,
  itemId: string
): Promise<{ ok: boolean; endResults: EndResult[] } | null> {
  const item = await getItemWithListings(userId, itemId);
  if (!item) return null;

  const endResults = await endListings(userId, item.listings, null);
  if (endResults.every((r) => r.ok) && item.status === "listed") {
    await getSupabaseAdmin()
      .from("inventory_items")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", itemId)
      .eq("user_id", userId);
  }
  return { ok: endResults.every((r) => r.ok), endResults };
}

export async function archiveItem(userId: string, itemId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw new Error(`archive failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

// ─── Direct-sale webhook entry point ──────────────────────────────────────────

/**
 * A Stripe payment-link checkout completed: find the listing, mark its item
 * sold, and end every other channel. Safe on replays — markItemSold is
 * idempotent and an already-ended listing set is a no-op.
 */
export async function handleDirectSale(
  paymentLinkId: string,
  amountTotalCents: number | null
): Promise<void> {
  const { data: listing } = await getSupabaseAdmin()
    .from("marketplace_listings")
    .select("user_id, inventory_item_id")
    .eq("platform", "direct")
    .eq("external_id", paymentLinkId)
    .maybeSingle<{ user_id: string; inventory_item_id: string }>();

  if (!listing) {
    // Payment links created via /api/create-link (legacy flow) have no
    // inventory item — nothing to sync.
    console.log(`[inventory] direct sale for untracked link ${paymentLinkId}`);
    return;
  }

  await markItemSold(
    listing.user_id,
    listing.inventory_item_id,
    "direct",
    amountTotalCents !== null ? amountTotalCents / 100 : null
  );
}
