// The sold_events queue (docs/design/launch.md P0-6/7) — the anti-oversell
// core. Every "it sold" signal, whether a webhook/notification push or the
// polling backstop, is normalized into one queue row, deduplicated by
// (platform, order, listing), and processed exactly once:
//
//   claim the sale atomically (claim_item_sale — first committed claim wins)
//     → won, quantity 0:  delist the item on every other channel + audit
//     → won, quantity >0: stock remains, nothing to delist + audit
//     → lost:             the double-sale race loser — out-of-stock
//                         cancel/refund path (stub) + audit 'oos_cancel'
//
// Deps are injectable so the race semantics are tested without a database.

import { getSupabaseAdmin } from "@/lib/connections";
import { endOtherListings } from "@/lib/inventory";
import type { EndResult } from "@/lib/inventory";
import { recordAudit } from "@/lib/audit";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SoldEventInput {
  userId: string;
  platform: string;
  externalOrderId: string;
  listingExternalId: string | null;
  sku: string | null;
  salePrice: number | null;
  source: "webhook" | "poll" | "manual";
  raw?: Record<string, unknown>;
}

export interface SoldEventRow {
  id: number;
  user_id: string;
  platform: string;
  external_order_id: string;
  listing_external_id: string | null;
  sku: string | null;
  sale_price: number | null;
  status: "pending" | "processed" | "oversold" | "unmatched" | "error";
}

export interface ProcessSummary {
  processed: number;
  oversold: number;
  unmatched: number;
  errors: number;
}

// ─── Intake ───────────────────────────────────────────────────────────────────

/**
 * Enqueue a sold signal. Duplicate (platform, order, listing) rows are
 * silently dropped — webhook retries and poll overlap are no-ops.
 * Returns the new event id, or null when it was a duplicate.
 */
export async function recordSoldEvent(
  evt: SoldEventInput
): Promise<number | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("sold_events")
    .insert({
      user_id: evt.userId,
      platform: evt.platform,
      external_order_id: evt.externalOrderId,
      listing_external_id: evt.listingExternalId,
      sku: evt.sku,
      sale_price: evt.salePrice,
      source: evt.source,
      raw: evt.raw ?? {},
    })
    .select("id")
    .single<{ id: number }>();
  if (error) {
    // 23505 = unique_violation → the dedupe index did its job.
    if (error.code === "23505") return null;
    throw new Error(`sold event insert failed: ${error.message}`);
  }
  return data.id;
}

/** Webhook intake has no user context — attribute by the listing's ids. */
export async function findListingOwner(
  platform: string,
  listingExternalId: string | null,
  sku: string | null
): Promise<{ userId: string; inventoryItemId: string } | null> {
  const supabase = getSupabaseAdmin();
  if (listingExternalId) {
    const { data } = await supabase
      .from("marketplace_listings")
      .select("user_id, inventory_item_id")
      .eq("platform", platform)
      .eq("external_id", listingExternalId)
      .limit(1)
      .maybeSingle<{ user_id: string; inventory_item_id: string }>();
    if (data) {
      return { userId: data.user_id, inventoryItemId: data.inventory_item_id };
    }
  }
  if (sku) {
    const { data } = await supabase
      .from("marketplace_listings")
      .select("user_id, inventory_item_id")
      .eq("platform", platform)
      .eq("meta->>sku", sku)
      .limit(1)
      .maybeSingle<{ user_id: string; inventory_item_id: string }>();
    if (data) {
      return { userId: data.user_id, inventoryItemId: data.inventory_item_id };
    }
  }
  return null;
}

// ─── Processing ───────────────────────────────────────────────────────────────

export interface SoldEventDeps {
  fetchPending(userId: string | null, limit: number): Promise<SoldEventRow[]>;
  matchListing(
    userId: string,
    platform: string,
    listingExternalId: string | null,
    sku: string | null
  ): Promise<{ inventoryItemId: string } | null>;
  claimSale(
    itemId: string,
    userId: string,
    platform: string,
    price: number | null
  ): Promise<{ won: boolean; remainingQuantity: number }>;
  endOthers(
    userId: string,
    itemId: string,
    soldPlatform: string
  ): Promise<EndResult[]>;
  markEvent(
    id: number,
    patch: {
      status: SoldEventRow["status"];
      inventoryItemId?: string;
      error?: string;
    }
  ): Promise<void>;
  audit: typeof recordAudit;
  // Double-sale loser path: cancel/refund the order that can't be fulfilled.
  // STUB for launch — records intent; the platform-side cancel API call is a
  // follow-up (see LAUNCH_STATUS).
  oversellAction(evt: SoldEventRow): Promise<void>;
}

const defaultDeps: SoldEventDeps = {
  async fetchPending(userId, limit) {
    let query = getSupabaseAdmin()
      .from("sold_events")
      .select(
        "id, user_id, platform, external_order_id, listing_external_id, sku, sale_price, status"
      )
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) throw new Error(`pending events read failed: ${error.message}`);
    return (data ?? []) as SoldEventRow[];
  },

  async matchListing(userId, platform, listingExternalId, sku) {
    const owner = await findListingOwner(platform, listingExternalId, sku);
    if (!owner || owner.userId !== userId) return null;
    return { inventoryItemId: owner.inventoryItemId };
  },

  async claimSale(itemId, userId, platform, price) {
    const { data, error } = await getSupabaseAdmin().rpc("claim_item_sale", {
      p_item_id: itemId,
      p_user_id: userId,
      p_platform: platform,
      p_price: price,
    });
    if (error) throw new Error(`claim failed: ${error.message}`);
    const row = (data as Array<{ won: boolean; remaining_quantity: number }>)[0];
    return { won: row.won, remainingQuantity: row.remaining_quantity };
  },

  endOthers: endOtherListings,

  async markEvent(id, patch) {
    const { error } = await getSupabaseAdmin()
      .from("sold_events")
      .update({
        status: patch.status,
        inventory_item_id: patch.inventoryItemId ?? null,
        error: patch.error ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) console.error("[sold-events] mark failed:", error.message);
  },

  audit: recordAudit,

  async oversellAction(evt) {
    // Launch stub: the order exists on the platform but stock is gone.
    // Follow-up wires the platform cancel/refund API; the audit row below
    // is the operator's signal to act manually until then.
    console.warn(
      `[sold-events] OVERSOLD: ${evt.platform} order ${evt.external_order_id} lost the stock race — cancel/refund needed`
    );
  },
};

export async function processSoldEvent(
  evt: SoldEventRow,
  deps: SoldEventDeps = defaultDeps
): Promise<"processed" | "oversold" | "unmatched" | "error"> {
  try {
    const match = await deps.matchListing(
      evt.user_id,
      evt.platform,
      evt.listing_external_id,
      evt.sku
    );
    if (!match) {
      await deps.markEvent(evt.id, { status: "unmatched" });
      return "unmatched";
    }

    const claim = await deps.claimSale(
      match.inventoryItemId,
      evt.user_id,
      evt.platform,
      evt.sale_price
    );

    if (!claim.won) {
      // Double-sale race loser: someone else's claim committed first.
      await deps.oversellAction(evt);
      await deps.audit(evt.user_id, match.inventoryItemId, "oos_cancel", evt.platform, {
        orderId: evt.external_order_id,
        note: "stock race lost — cancel/refund the platform order (stubbed)",
      });
      await deps.markEvent(evt.id, {
        status: "oversold",
        inventoryItemId: match.inventoryItemId,
      });
      return "oversold";
    }

    await deps.audit(evt.user_id, match.inventoryItemId, "sold_event", evt.platform, {
      orderId: evt.external_order_id,
      salePrice: evt.sale_price,
      remainingQuantity: claim.remainingQuantity,
    });

    // Quantity exhausted → the never-oversell promise: end it everywhere else.
    if (claim.remainingQuantity <= 0) {
      await deps.endOthers(evt.user_id, match.inventoryItemId, evt.platform);
    }

    await deps.markEvent(evt.id, {
      status: "processed",
      inventoryItemId: match.inventoryItemId,
    });
    return "processed";
  } catch (err) {
    const message = err instanceof Error ? err.message : "processing failed";
    await deps.markEvent(evt.id, { status: "error", error: message });
    return "error";
  }
}

// ─── Direct (Stripe) sale intake ──────────────────────────────────────────────

/**
 * A Stripe payment-link checkout completed. Routed through the same
 * sold_events queue as every marketplace sale — atomic claim, cross-channel
 * delist (including deactivating the payment link itself, per
 * planEndListings' direct-platform rule), and audit rows.
 *
 * Dedupe key is the checkout SESSION id, not the payment-link id: links are
 * reusable, sessions are one per sale, and Stripe retries redeliver the
 * same session.
 */
export interface DirectSaleIO {
  findOwner: typeof findListingOwner;
  record: typeof recordSoldEvent;
  process: (userId: string) => Promise<ProcessSummary>;
}

export async function handleDirectSale(
  paymentLinkId: string,
  checkoutSessionId: string,
  amountTotalCents: number | null,
  io: DirectSaleIO = {
    findOwner: findListingOwner,
    record: recordSoldEvent,
    process: (userId) => processPendingSoldEvents(userId),
  }
): Promise<void> {
  const owner = await io.findOwner("direct", paymentLinkId, null);
  if (!owner) {
    // Payment links created via /api/create-link (legacy flow) have no
    // inventory item — nothing to sync.
    console.log(`[sold-events] direct sale for untracked link ${paymentLinkId}`);
    return;
  }

  await io.record({
    userId: owner.userId,
    platform: "direct",
    externalOrderId: checkoutSessionId,
    listingExternalId: paymentLinkId,
    sku: null,
    salePrice: amountTotalCents !== null ? amountTotalCents / 100 : null,
    source: "webhook",
  });
  await io.process(owner.userId);
}

/**
 * Drain pending events (optionally for one user). Events are independent —
 * a failure marks that event 'error' and the rest continue.
 */
export async function processPendingSoldEvents(
  userId: string | null = null,
  limit = 50,
  deps: SoldEventDeps = defaultDeps
): Promise<ProcessSummary> {
  const events = await deps.fetchPending(userId, limit);
  const summary: ProcessSummary = {
    processed: 0,
    oversold: 0,
    unmatched: 0,
    errors: 0,
  };
  for (const evt of events) {
    const outcome = await processSoldEvent(evt, deps);
    if (outcome === "processed") summary.processed += 1;
    else if (outcome === "oversold") summary.oversold += 1;
    else if (outcome === "unmatched") summary.unmatched += 1;
    else summary.errors += 1;
  }
  return summary;
}
