// Inventory as source of truth (server-only).
//
// Every user publish creates an inventory item; every live marketplace
// listing points back to it. Selling or delisting an item ends its listings
// on every other channel — the "never oversell" promise. Decisions about
// WHICH listings to end live in lib/inventory-rules.ts (pure, tested);
// this module executes them against eBay/Etsy/Stripe.

import { getSupabaseAdmin, getConnection } from "@/lib/connections";
import { recordAudit } from "@/lib/audit";
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

// Latest publish attempt for an item — how a draft card explains WHY the
// item isn't live yet ("eBay: seller registration incomplete", …).
export interface LastPublishAttempt {
  platform: string;
  status:
    | "pending"
    | "live"
    | "assist"
    | "not_connected"
    | "error"
    | "reconciliation_required";
  error: string | null;
  created_at: string;
}

export interface InventoryItemRow {
  id: string;
  title: string;
  condition: string;
  photo_url: string | null;
  quantity: number;
  // null until the pricing engine (or the seller) prices the draft
  price: number | null;
  cost_of_goods: number | null;
  status: "draft" | "review" | "listed" | "sold" | "archived";
  // why the guardrails held this item (empty unless status === "review")
  review_reasons: Array<{ gate: string; reason: string }>;
  sold_at: string | null;
  sold_price: number | null;
  sold_platform: string | null;
  created_at: string;
  listings: ListingRow[];
  // most recent publish attempt (null when the item was never published)
  last_attempt: LastPublishAttempt | null;
}

export interface EndResult {
  platform: string;
  ok: boolean;
  error?: string;
}

// ─── Intake (called from the auto-list pipeline the moment identification
//     succeeds — before any price exists) ─────────────────────────────────────

export interface DraftItemInput {
  title: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  condition: string;
  category: string;
  specs: Record<string, string>;
  defects: string[];
  // 0-1 from lib/ai/vision.ts
  idConfidence: number;
  costOfGoods: number | null;
  // Estimated shipping cost from extraction; null = MANUAL_ESTIMATE_NEEDED.
  // Persisted so republishing a draft never re-runs AI — and never silently
  // downgrades a known shipping cost to "unknown".
  shippingCost: number | null;
}

export async function createDraftItem(
  userId: string,
  input: DraftItemInput,
  photoUrl: string | null
): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .insert({
      user_id: userId,
      title: input.title,
      brand: input.brand,
      model: input.model,
      upc: input.upc,
      condition: input.condition,
      category: input.category,
      specs: input.specs,
      defects: input.defects,
      id_confidence: input.idConfidence,
      cost_of_goods: input.costOfGoods,
      shipping_cost: input.shippingCost,
      photo_url: photoUrl,
    })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(`draft item insert failed: ${error.message}`);
  return data.id;
}

/**
 * Route an item to the human review queue with the guardrail failures that
 * put it there (P0-5). Only drafts move — an already-listed/sold item is
 * never pulled back into review by a late pipeline retry.
 */
export async function setItemReview(
  userId: string,
  itemId: string,
  reasons: Array<{ gate: string; reason: string }>
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({
      status: "review",
      review_reasons: reasons,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("user_id", userId)
    .eq("status", "draft");
  if (error) throw new Error(`set review failed: ${error.message}`);
}

/** Full item detail — what the review queue, approval publish, draft
 *  publish/retry, and the item edit view need. */
export interface ItemDetailRow {
  id: string;
  title: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  condition: string;
  category: string | null;
  specs: Record<string, string>;
  photo_url: string | null;
  price: number | null;
  cost_of_goods: number | null;
  shipping_cost: number | null;
  status: "draft" | "review" | "listed" | "sold" | "archived";
  review_reasons: Array<{ gate: string; reason: string }>;
}

export async function getItemDetail(
  userId: string,
  itemId: string
): Promise<ItemDetailRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .select(
      "id, title, brand, model, upc, condition, category, specs, photo_url, price, cost_of_goods, shipping_cost, status, review_reasons"
    )
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle<ItemDetailRow>();
  if (error) throw new Error(`item detail read failed: ${error.message}`);
  return data;
}

/** Human approved a held item — release it back to draft for publishing. */
export async function approveItemFromReview(
  userId: string,
  itemId: string
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({ status: "draft", updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("user_id", userId)
    .eq("status", "review")
    .select("id");
  if (error) throw new Error(`approve failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Seller-editable listing fields (item edit view). Only drafts and
 *  review-held items are editable — a live listing is edited on the
 *  marketplace, not here, so the stored row never desyncs from it. */
export interface ItemUpdateInput {
  title?: string;
  price?: number;
  condition?: string;
  shippingCost?: number | null;
  costOfGoods?: number | null;
  // Full replacement of the specs jsonb: eBay item specifics entered in the
  // draft-edit form, plus reserved __keys (chosen eBay category). Persisted
  // so republish/retry reuses them without re-running AI.
  specs?: Record<string, string>;
}

export async function updateItemDetails(
  userId: string,
  itemId: string,
  patch: ItemUpdateInput
): Promise<boolean> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.price !== undefined) update.price = patch.price;
  if (patch.condition !== undefined) update.condition = patch.condition;
  if (patch.shippingCost !== undefined) update.shipping_cost = patch.shippingCost;
  if (patch.costOfGoods !== undefined) update.cost_of_goods = patch.costOfGoods;
  if (patch.specs !== undefined) update.specs = patch.specs;

  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update(update)
    .eq("id", itemId)
    .eq("user_id", userId)
    .in("status", ["draft", "review"])
    .select("id");
  if (error) throw new Error(`item update failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Merge keys into a draft's specs jsonb without replacing the rest — used by
 * the draft-time aspects endpoint to PIN its category resolution
 * (__ebayCategoryId) on the row, so the breadcrumb, the form, and the
 * publish step all use ONE answer instead of re-resolving independently.
 * Drafts and review-held items only.
 */
export async function mergeItemSpecs(
  userId: string,
  itemId: string,
  patch: Record<string, string>
): Promise<boolean> {
  const item = await getItemDetail(userId, itemId);
  if (!item || (item.status !== "draft" && item.status !== "review")) {
    return false;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({
      specs: { ...(item.specs ?? {}), ...patch },
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("user_id", userId)
    .in("status", ["draft", "review"])
    .select("id");
  if (error) throw new Error(`specs merge failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Human rejected a held item — archive it, never publish. */
export async function rejectItemFromReview(
  userId: string,
  itemId: string
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("user_id", userId)
    .eq("status", "review")
    .select("id");
  if (error) throw new Error(`reject failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Stamp the pricing engine's decision onto the item. */
export async function setItemPrice(
  userId: string,
  itemId: string,
  price: number
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({ price, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("user_id", userId);
  if (error) throw new Error(`set price failed: ${error.message}`);
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
      shipping_cost: listing.shippingCost,
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

export type PublishAttemptStatus =
  | "pending"
  | "live"
  | "assist"
  | "not_connected"
  | "error"
  // The listing IS live on the marketplace but local recording failed —
  // the attempt row carries the platform ids needed to re-adopt it.
  | "reconciliation_required";

/** One-shot terminal rows for outcomes where NO external call happened
 *  (not_connected, assist copy, pre-call failures). Real marketplace calls
 *  must use beginPublishAttempt/completePublishAttempt instead so the row
 *  exists BEFORE the external side effect. */
export async function recordPublishAttempt(
  userId: string,
  inventoryItemId: string | null,
  platform: string,
  status: Exclude<PublishAttemptStatus, "pending">,
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

/**
 * Persist-before-publish: insert the 'pending' attempt row BEFORE any
 * external marketplace call. THROWS when the row can't be written — in that
 * case the caller must NOT publish (an untracked publish is the exact
 * failure mode this exists to prevent).
 */
export async function beginPublishAttempt(
  userId: string,
  inventoryItemId: string | null,
  platform: string
): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("publish_attempts")
    .insert({
      user_id: userId,
      inventory_item_id: inventoryItemId,
      platform,
      status: "pending",
    })
    .select("id")
    .single<{ id: number }>();
  if (error) {
    throw new Error(`publish attempt record failed: ${error.message}`);
  }
  return String(data.id);
}

export interface PublishAttemptCompletion {
  status: Exclude<PublishAttemptStatus, "pending">;
  error?: string;
  // Platform-side identifiers — REQUIRED for live and
  // reconciliation_required so an unmanaged listing stays recoverable.
  externalId?: string;
  url?: string;
  meta?: Record<string, string>;
}

/** Stamp the outcome onto the pending attempt row. Returns false (and logs
 *  loudly) when the update failed — callers treat that as reconciliation. */
export async function completePublishAttempt(
  attemptId: string,
  completion: PublishAttemptCompletion
): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from("publish_attempts")
    .update({
      status: completion.status,
      error: completion.error ?? null,
      external_id: completion.externalId ?? null,
      url: completion.url ?? null,
      meta: completion.meta ?? {},
    })
    .eq("id", attemptId);
  if (error) {
    console.error(
      `[inventory] RECONCILIATION: attempt ${attemptId} completion (${completion.status}, external ${completion.externalId ?? "?"}) failed to persist:`,
      error.message
    );
    return false;
  }
  return true;
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
      "id, title, condition, photo_url, quantity, price, cost_of_goods, status, review_reasons, sold_at, sold_price, sold_platform, created_at"
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

  // Latest publish attempt per item — the "why isn't this live?" a draft
  // card shows. Best-effort: a read failure must not break the inventory.
  const attemptByItem = new Map<string, LastPublishAttempt>();
  const { data: attempts } = await supabase
    .from("publish_attempts")
    .select("inventory_item_id, platform, status, error, created_at")
    .in(
      "inventory_item_id",
      items.map((i) => i.id)
    )
    .order("created_at", { ascending: false })
    .limit(500);
  for (const a of attempts ?? []) {
    const key = a.inventory_item_id as string;
    if (!attemptByItem.has(key)) {
      attemptByItem.set(key, {
        platform: a.platform as string,
        status: a.status as LastPublishAttempt["status"],
        error: (a.error as string | null) ?? null,
        created_at: a.created_at as string,
      });
    }
  }

  return items.map((item) => ({
    ...(item as Omit<InventoryItemRow, "listings" | "last_attempt">),
    listings: byItem.get(item.id) ?? [],
    last_attempt: attemptByItem.get(item.id) ?? null,
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
  itemId: string,
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
        // P0-8: every automated delist leaves an audit row.
        await recordAudit(userId, itemId, "auto_delist", listing.platform, {
          listingId: listing.external_id,
          trigger: soldPlatform ? `sold on ${soldPlatform}` : "delist",
        });
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

  const endResults = await endListings(userId, itemId, item.listings, soldPlatform);
  return { ok: endResults.every((r) => r.ok), endResults };
}

/**
 * End every listing on channels other than the one that sold (P0-7's
 * delist-everywhere step). Used by the sold_events processor after a won
 * claim; the claim itself already stamped the sale facts atomically.
 */
export async function endOtherListings(
  userId: string,
  itemId: string,
  soldPlatform: string
): Promise<EndResult[]> {
  const item = await getItemWithListings(userId, itemId);
  if (!item) return [];
  return endListings(userId, itemId, item.listings, soldPlatform);
}

/** End all listings without a sale (pull the item back to draft). */
export async function delistItem(
  userId: string,
  itemId: string
): Promise<{ ok: boolean; endResults: EndResult[] } | null> {
  const item = await getItemWithListings(userId, itemId);
  if (!item) return null;

  const endResults = await endListings(userId, itemId, item.listings, null);
  if (endResults.every((r) => r.ok) && item.status === "listed") {
    await getSupabaseAdmin()
      .from("inventory_items")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", itemId)
      .eq("user_id", userId);
  }
  return { ok: endResults.every((r) => r.ok), endResults };
}

/** Record what the item cost — the input profit analytics is built on. */
export async function setItemCost(
  userId: string,
  itemId: string,
  costOfGoods: number
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("inventory_items")
    .update({ cost_of_goods: costOfGoods, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw new Error(`set cost failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
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

// Direct-sale webhook entry point moved to lib/sold-events.ts
// (handleDirectSale) so Stripe sales flow through the same sold_events
// queue — atomic claim, cross-channel delist, audit — as every other
// platform. Keeping it here would create an import cycle (sold-events
// already imports endOtherListings from this module).
