import { describe, it, expect, vi } from "vitest";
import {
  processSoldEvent,
  processPendingSoldEvents,
  handleDirectSale,
} from "./sold-events";
import type { SoldEventDeps, SoldEventRow, DirectSaleIO } from "./sold-events";

function event(over: Partial<SoldEventRow> = {}): SoldEventRow {
  return {
    id: 1,
    user_id: "user-1",
    platform: "ebay",
    external_order_id: "order-1",
    listing_external_id: "listing-100",
    sku: "snap-1",
    sale_price: 49.99,
    status: "pending",
    ...over,
  };
}

// Fake claim backed by shared quantity state — mimics the SQL function's
// guarded UPDATE: decrement only while stock remains, first caller wins.
function stockClaim(initialQty: number) {
  const state = { qty: initialQty };
  return vi.fn(async () => {
    if (state.qty <= 0) return { won: false, remainingQuantity: 0 };
    state.qty -= 1;
    return { won: true, remainingQuantity: state.qty };
  });
}

function fakeDeps(over: Partial<SoldEventDeps> = {}): SoldEventDeps {
  return {
    fetchPending: vi.fn().mockResolvedValue([]),
    matchListing: vi.fn().mockResolvedValue({ inventoryItemId: "item-1" }),
    claimSale: stockClaim(1),
    endOthers: vi.fn().mockResolvedValue([]),
    markEvent: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    oversellAction: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("processSoldEvent", () => {
  it("claims the sale, delists other channels at qty 0, audits, marks processed", async () => {
    const deps = fakeDeps();
    const outcome = await processSoldEvent(event(), deps);

    expect(outcome).toBe("processed");
    expect(deps.endOthers).toHaveBeenCalledWith("user-1", "item-1", "ebay");
    expect(deps.audit).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      "sold_event",
      "ebay",
      expect.objectContaining({ orderId: "order-1", remainingQuantity: 0 })
    );
    expect(deps.markEvent).toHaveBeenCalledWith(1, {
      status: "processed",
      inventoryItemId: "item-1",
    });
  });

  it("keeps other channels live while stock remains", async () => {
    const deps = fakeDeps({ claimSale: stockClaim(3) });
    const outcome = await processSoldEvent(event(), deps);
    expect(outcome).toBe("processed");
    expect(deps.endOthers).not.toHaveBeenCalled();
  });

  it("marks unmatched when no listing corresponds to the sale", async () => {
    const deps = fakeDeps({ matchListing: vi.fn().mockResolvedValue(null) });
    const outcome = await processSoldEvent(event(), deps);
    expect(outcome).toBe("unmatched");
    expect(deps.claimSale).not.toHaveBeenCalled();
  });

  it("marks error (and keeps going) when a step throws", async () => {
    const deps = fakeDeps({
      claimSale: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const outcome = await processSoldEvent(event(), deps);
    expect(outcome).toBe("error");
    expect(deps.markEvent).toHaveBeenCalledWith(1, {
      status: "error",
      error: "db down",
    });
  });
});

describe("double-sale race (the core anti-oversell promise)", () => {
  it("first committed claim wins; the loser takes the out-of-stock cancel path", async () => {
    // One unit in stock, the same item sells on eBay and Etsy near-simultaneously.
    const deps = fakeDeps({ claimSale: stockClaim(1) });
    const ebaySale = event({ id: 1, platform: "ebay", external_order_id: "e-1" });
    const etsySale = event({ id: 2, platform: "etsy", external_order_id: "t-1" });

    const [first, second] = await Promise.all([
      processSoldEvent(ebaySale, deps),
      processSoldEvent(etsySale, deps),
    ]);

    // Exactly one winner, exactly one oversold — never two sales of one unit.
    expect([first, second].sort()).toEqual(["oversold", "processed"]);

    // The loser triggered the cancel/refund stub and its audit row.
    expect(deps.oversellAction).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      "oos_cancel",
      expect.any(String),
      expect.objectContaining({ note: expect.stringContaining("race lost") })
    );

    // The winner delisted the other channels exactly once.
    expect(deps.endOthers).toHaveBeenCalledTimes(1);
  });

  it("replay of the winning order after stock is gone becomes oversold, not a double delist", async () => {
    const deps = fakeDeps({ claimSale: stockClaim(1) });
    await processSoldEvent(event({ id: 1 }), deps);
    // duplicate insert is normally blocked by the dedupe index; this covers
    // the belt-and-braces path where a replay still reaches processing
    const replay = await processSoldEvent(event({ id: 3 }), deps);
    expect(replay).toBe("oversold");
    expect(deps.endOthers).toHaveBeenCalledTimes(1);
  });
});

describe("handleDirectSale (Stripe → queue)", () => {
  function io(over: Partial<DirectSaleIO> = {}): DirectSaleIO {
    return {
      findOwner: vi
        .fn()
        .mockResolvedValue({ userId: "user-1", inventoryItemId: "item-1" }),
      record: vi.fn().mockResolvedValue(1),
      process: vi
        .fn()
        .mockResolvedValue({ processed: 1, oversold: 0, unmatched: 0, errors: 0 }),
      ...over,
    };
  }

  it("enqueues on the checkout session id (links are reusable) and drains", async () => {
    const deps = io();
    await handleDirectSale("plink_1", "cs_123", 4999, deps);
    expect(deps.record).toHaveBeenCalledWith({
      userId: "user-1",
      platform: "direct",
      externalOrderId: "cs_123",
      listingExternalId: "plink_1",
      sku: null,
      salePrice: 49.99,
      source: "webhook",
    });
    expect(deps.process).toHaveBeenCalledWith("user-1");
  });

  it("ignores untracked legacy payment links", async () => {
    const deps = io({ findOwner: vi.fn().mockResolvedValue(null) });
    await handleDirectSale("plink_legacy", "cs_1", 1000, deps);
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.process).not.toHaveBeenCalled();
  });
});

describe("processPendingSoldEvents", () => {
  it("drains the queue and tallies outcomes independently", async () => {
    const deps = fakeDeps({
      fetchPending: vi
        .fn()
        .mockResolvedValue([
          event({ id: 1, external_order_id: "a" }),
          event({ id: 2, external_order_id: "b" }),
          event({ id: 3, external_order_id: "c" }),
        ]),
      claimSale: stockClaim(2),
    });
    const summary = await processPendingSoldEvents("user-1", 50, deps);
    expect(summary).toEqual({
      processed: 2,
      oversold: 1,
      unmatched: 0,
      errors: 0,
    });
  });
});
