// Regression: the eBay sold-detection → auto-delist loop, end-to-end.
//
// Exercises the REAL functions the poll uses — no network, no DB:
//   getOrders payload → extractEbaySales → matchSales (SKU → inventory item)
//     → processSoldEvent → claim (atomic) → endOthers (cross-channel delist).
//
// The delist ENGINE itself (markItemSold/endOtherListings, claim_item_sale) is
// covered by lib/inventory + the SQL migration; here we lock the trigger→engine
// wiring and the three guarantees the brief calls out:
//   1. a fetched PAID order maps SKU → item and calls the delist engine,
//   2. the same order twice → exactly one delist (idempotent, first-commit-wins),
//   3. an unmapped SKU is skipped and the scan continues.

import { describe, it, expect, vi } from "vitest";
import { extractEbaySales } from "@/lib/platforms/ebay";
import { matchSales } from "@/lib/order-sync";
import type { SaleKey, OpenListing } from "@/lib/order-sync";
import {
  processSoldEvent,
  processPendingSoldEvents,
} from "@/lib/sold-events";
import type { SoldEventDeps, SoldEventRow } from "@/lib/sold-events";

// A realistic Sell Fulfillment API getOrders response: one PAID order with a
// SKU-bearing line item, plus one UNPAID order that must be ignored.
function getOrdersPayload() {
  return {
    orders: [
      {
        orderId: "12-34567-89012",
        orderPaymentStatus: "PAID",
        lineItems: [
          {
            legacyItemId: "110566789012",
            sku: "snap-1717000000000",
            total: { value: "89.99", currency: "USD" },
          },
        ],
      },
      {
        orderId: "99-00000-00000",
        orderPaymentStatus: "PENDING", // not paid → skipped
        lineItems: [{ legacyItemId: "1", sku: "snap-x", total: { value: "5.00" } }],
      },
    ],
  };
}

// Our stored open listing for that SKU/listing id.
const openListings: OpenListing[] = [
  {
    inventoryItemId: "item-1",
    externalId: "110566789012",
    sku: "snap-1717000000000",
    status: "live",
  },
];

const saleKeys = (): SaleKey[] =>
  extractEbaySales(getOrdersPayload()).map((s) => ({
    orderId: s.orderId,
    listingId: s.listingId,
    sku: s.sku,
    price: s.price,
  }));

function soldEvent(over: Partial<SoldEventRow> = {}): SoldEventRow {
  return {
    id: 1,
    user_id: "user-1",
    platform: "ebay",
    external_order_id: "12-34567-89012",
    listing_external_id: "110566789012",
    sku: "snap-1717000000000",
    sale_price: 89.99,
    status: "pending",
    ...over,
  };
}

// Fake claim backed by shared stock: decrement only while qty > 0, first wins —
// mirrors the claim_item_sale guarded UPDATE without a database.
function stockClaim(initialQty: number) {
  const state = { qty: initialQty };
  return vi.fn(async () => {
    if (state.qty <= 0) return { won: false, remainingQuantity: 0 };
    state.qty -= 1;
    return { won: true, remainingQuantity: state.qty };
  });
}

function deps(over: Partial<SoldEventDeps> = {}): SoldEventDeps {
  return {
    fetchPending: vi.fn().mockResolvedValue([]),
    // matchListing resolves SKU/listing → our inventory item (the reverse map).
    matchListing: vi.fn(async (_u, _p, listingId, sku) => {
      const hit = openListings.find(
        (l) => l.externalId === listingId || (sku && l.sku === sku)
      );
      return hit ? { inventoryItemId: hit.inventoryItemId } : null;
    }),
    claimSale: stockClaim(1),
    endOthers: vi.fn().mockResolvedValue([]),
    markEvent: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    oversellAction: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("eBay sold-detection → auto-delist (end-to-end)", () => {
  it("1. a fetched PAID order maps SKU → inventory item and calls the delist engine", async () => {
    // extract: only the PAID order surfaces, with its SKU + price
    const sales = extractEbaySales(getOrdersPayload());
    expect(sales).toEqual([
      {
        orderId: "12-34567-89012",
        listingId: "110566789012",
        sku: "snap-1717000000000",
        price: 89.99,
      },
    ]);

    // reverse-map: SKU/listing → inventory item
    const matches = matchSales(saleKeys(), openListings);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      inventoryItemId: "item-1",
      price: 89.99,
      orderId: "12-34567-89012",
    });

    // process: claims the sale, then delists OTHER channels for that item
    const d = deps();
    const outcome = await processSoldEvent(soldEvent(), d);
    expect(outcome).toBe("processed");
    expect(d.claimSale).toHaveBeenCalledWith("item-1", "user-1", "ebay", 89.99);
    expect(d.endOthers).toHaveBeenCalledWith("user-1", "item-1", "ebay");
    expect(d.markEvent).toHaveBeenCalledWith(1, {
      status: "processed",
      inventoryItemId: "item-1",
    });
  });

  it("2. the same order processed twice → exactly one delist (idempotent, first commit wins)", async () => {
    const d = deps({ claimSale: stockClaim(1) });
    const first = await processSoldEvent(soldEvent({ id: 1 }), d);
    // a replay that still reaches processing finds stock gone → oversold, no 2nd delist
    const replay = await processSoldEvent(soldEvent({ id: 2 }), d);

    expect(first).toBe("processed");
    expect(replay).toBe("oversold");
    expect(d.endOthers).toHaveBeenCalledTimes(1); // exactly one delist
    expect(d.oversellAction).toHaveBeenCalledTimes(1); // loser takes the OOS path
  });

  it("3. an unmapped SKU is skipped (unmatched) and the scan continues", async () => {
    // matchSales drops a sale whose SKU/listing matches no open listing
    const strayKey: SaleKey = {
      orderId: "77",
      listingId: "does-not-exist",
      sku: "snap-unknown",
      price: 10,
    };
    expect(matchSales([strayKey], openListings)).toEqual([]);

    // and the queue processor marks it unmatched without claiming/delisting,
    // then keeps draining the rest of the batch
    const pending = [
      soldEvent({ id: 1, external_order_id: "A" }),
      soldEvent({
        id: 2,
        external_order_id: "B",
        listing_external_id: "does-not-exist",
        sku: "snap-unknown",
      }),
      soldEvent({ id: 3, external_order_id: "C" }),
    ];
    const d = deps({
      fetchPending: vi.fn().mockResolvedValue(pending),
      claimSale: stockClaim(5),
    });
    const summary = await processPendingSoldEvents("user-1", 50, d);

    expect(summary).toEqual({
      processed: 2,
      oversold: 0,
      unmatched: 1,
      errors: 0,
    });
    // the unmapped one is recorded as unmatched and never reaches the engine:
    // only the two mapped events attempt a claim.
    expect(d.markEvent).toHaveBeenCalledWith(2, { status: "unmatched" });
    expect(d.claimSale).toHaveBeenCalledTimes(2);
  });
});
