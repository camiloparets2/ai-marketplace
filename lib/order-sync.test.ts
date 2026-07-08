import { describe, it, expect } from "vitest";
import { matchSales } from "./order-sync";
import type { OpenListing } from "./order-sync";
import { extractEbaySales } from "./platforms/ebay";
import { extractEtsySales } from "./platforms/etsy";

const listing = (
  inventoryItemId: string,
  externalId: string | null,
  sku: string | null = null,
  status: OpenListing["status"] = "live"
): OpenListing => ({ inventoryItemId, externalId, sku, status });

describe("matchSales", () => {
  it("matches by platform listing id", () => {
    const matches = matchSales(
      [{ orderId: "o-1", listingId: "111", sku: null, price: 42 }],
      [listing("item-1", "111")]
    );
    expect(matches).toEqual([
      {
        inventoryItemId: "item-1",
        price: 42,
        orderId: "o-1",
        listingId: "111",
        sku: null,
      },
    ]);
  });

  it("falls back to SKU when the listing id is absent", () => {
    const matches = matchSales(
      [{ orderId: "o-2", listingId: null, sku: "snap-123", price: 10 }],
      [listing("item-1", "999", "snap-123")]
    );
    expect(matches).toEqual([
      {
        inventoryItemId: "item-1",
        price: 10,
        orderId: "o-2",
        listingId: null,
        sku: "snap-123",
      },
    ]);
  });

  it("skips already-ended listings and unknown sales", () => {
    const matches = matchSales(
      [
        { orderId: "o-3", listingId: "111", sku: null, price: 5 },
        { orderId: "o-4", listingId: "not-ours", sku: null, price: 7 },
      ],
      [listing("item-1", "111", null, "ended")]
    );
    expect(matches).toEqual([]);
  });

  it("matches each inventory item at most once per pass", () => {
    const matches = matchSales(
      [
        { orderId: "o-5", listingId: "111", sku: null, price: 5 },
        { orderId: "o-6", listingId: "111", sku: null, price: 5 },
      ],
      [listing("item-1", "111")]
    );
    expect(matches).toHaveLength(1);
  });

  it("retries listings whose end previously failed", () => {
    const matches = matchSales(
      [{ orderId: "o-7", listingId: "111", sku: null, price: 5 }],
      [listing("item-1", "111", null, "end_failed")]
    );
    expect(matches).toHaveLength(1);
  });
});

describe("extractEbaySales", () => {
  it("extracts PAID line items with per-line price", () => {
    const sales = extractEbaySales({
      orders: [
        {
          orderId: "o-1",
          orderPaymentStatus: "PAID",
          pricingSummary: { total: { value: "50.00" } },
          lineItems: [
            { legacyItemId: "111", sku: "snap-1", total: { value: "30.00" } },
            { legacyItemId: "222", sku: null },
          ],
        },
        {
          orderId: "o-2",
          orderPaymentStatus: "PENDING",
          lineItems: [{ legacyItemId: "333" }],
        },
      ],
    });
    expect(sales).toEqual([
      { orderId: "o-1", listingId: "111", sku: "snap-1", price: 30 },
      { orderId: "o-1", listingId: "222", sku: null, price: 50 },
    ]);
  });

  it("returns empty on malformed payloads", () => {
    expect(extractEbaySales({})).toEqual([]);
    expect(extractEbaySales({ orders: null })).toEqual([]);
  });
});

describe("extractEtsySales", () => {
  it("extracts paid transactions with divisor money math", () => {
    const sales = extractEtsySales({
      results: [
        {
          receipt_id: 9,
          is_paid: true,
          grandtotal: { amount: 5000, divisor: 100 },
          transactions: [
            { listing_id: 777, price: { amount: 2500, divisor: 100 } },
            { listing_id: 888, price: null },
          ],
        },
        { receipt_id: 10, is_paid: false, transactions: [{ listing_id: 999 }] },
      ],
    });
    expect(sales).toEqual([
      { receiptId: "9", listingId: "777", price: 25 },
      { receiptId: "9", listingId: "888", price: 50 },
    ]);
  });

  it("returns empty on malformed payloads", () => {
    expect(extractEtsySales({})).toEqual([]);
  });
});
