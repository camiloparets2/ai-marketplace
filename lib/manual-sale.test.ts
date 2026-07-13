// Manual "Mark sold" audit trail (sandbox finding: the manual path wrote NO
// sold_events row — inventory said 'sold', listings said 'ended', and the
// queue said nothing happened). Every sale, from every source, normalizes
// into sold_events; the manual path now routes through the SAME processor
// as connector-detected sales.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

const { recorder } = vi.hoisted(() => {
  const state = {
    calls: [] as RecordedCall[],
    // Per-table awaited result; default empty.
    results: {} as Record<string, { data: unknown; error: unknown }>,
  };
  function builder(table: string): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const method of [
      "select", "eq", "neq", "in", "upsert", "insert", "update", "delete",
      "order", "limit", "maybeSingle", "single",
    ]) {
      b[method] = (...args: unknown[]) => {
        state.calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve(state.results[table] ?? { data: null, error: null });
    return b;
  }
  return {
    recorder: {
      state,
      client: { from: (table: string) => builder(table) },
      reset(results: Record<string, { data: unknown; error: unknown }> = {}) {
        state.calls = [];
        state.results = results;
      },
    },
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => recorder.client),
}));

import {
  handleManualSale,
  manualOrderId,
  recordSoldEvent,
  processSoldEvent,
} from "./sold-events";
import type { ManualSaleIO, SoldEventDeps, SoldEventRow } from "./sold-events";

function fakeIO(over: Partial<ManualSaleIO> = {}): ManualSaleIO {
  return {
    record: vi.fn(async () => 1),
    process: vi.fn(async () => ({
      processed: 1,
      oversold: 0,
      unmatched: 0,
      errors: 0,
    })),
    endOthers: vi.fn(async () => [{ platform: "ebay", ok: true as const }]),
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  recorder.reset({
    inventory_items: { data: { id: "item-1" }, error: null },
    marketplace_listings: {
      data: { external_id: "110589875643", meta: { sku: "snap-item-1" } },
      error: null,
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleManualSale — one queue, one processor, always audited", () => {
  it("writes exactly ONE sold_events row with the full audit payload", async () => {
    const io = fakeIO();
    const result = await handleManualSale("user-1", "item-1", "ebay", 25, io);
    expect(result).toEqual({
      ok: true,
      endResults: [{ platform: "ebay", ok: true }],
    });
    expect(io.record).toHaveBeenCalledTimes(1);
    expect(io.record).toHaveBeenCalledWith({
      userId: "user-1",
      platform: "ebay",
      externalOrderId: "manual:item-1",
      listingExternalId: "110589875643",
      sku: "snap-item-1",
      salePrice: 25,
      source: "manual",
      inventoryItemId: "item-1",
    });
    // The SAME processor as connector sales ran (claim + delist + audit).
    expect(io.process).toHaveBeenCalledWith("user-1");
  });

  it("re-clicking is idempotent: the dedupe key is deterministic and a duplicate still retries failed ends", async () => {
    // Second click: the dedupe index drops the insert (record → null).
    const io = fakeIO({ record: vi.fn(async () => null) });
    const result = await handleManualSale("user-1", "item-1", "ebay", 25, io);
    expect(result?.ok).toBe(true);
    // Same deterministic order id every time — that IS the idempotency.
    expect(manualOrderId("item-1")).toBe("manual:item-1");
    expect(vi.mocked(io.record).mock.calls[0][0].externalOrderId).toBe(
      manualOrderId("item-1")
    );
    // The end-others pass still ran, retrying any end_failed listing.
    expect(io.endOthers).toHaveBeenCalledWith("user-1", "item-1", "ebay");
  });

  it("returns null for an item the user doesn't own (route 404 contract) — nothing recorded", async () => {
    recorder.reset({ inventory_items: { data: null, error: null } });
    const io = fakeIO();
    expect(await handleManualSale("user-1", "missing", "ebay", 25, io)).toBeNull();
    expect(io.record).not.toHaveBeenCalled();
    expect(io.endOthers).not.toHaveBeenCalled();
  });

  it("works without a listing row (assist channels) — attribution rides on the item id", async () => {
    recorder.reset({
      inventory_items: { data: { id: "item-1" }, error: null },
      marketplace_listings: { data: null, error: null },
    });
    const io = fakeIO();
    await handleManualSale("user-1", "item-1", "facebook", 15, io);
    expect(io.record).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "facebook",
        listingExternalId: null,
        sku: null,
        inventoryItemId: "item-1",
      })
    );
  });
});

describe("recordSoldEvent — the manual row is environment-stamped", () => {
  it("stamps environment, source=manual, and the pre-attributed item id", async () => {
    recorder.reset({ sold_events: { data: { id: 7 }, error: null } });
    await recordSoldEvent({
      userId: "user-1",
      platform: "ebay",
      externalOrderId: manualOrderId("item-1"),
      listingExternalId: "110589875643",
      sku: "snap-item-1",
      salePrice: 25,
      source: "manual",
      inventoryItemId: "item-1",
    });
    const insert = recorder.state.calls.find(
      (c) => c.table === "sold_events" && c.method === "insert"
    );
    expect(insert?.args[0]).toMatchObject({
      source: "manual",
      external_order_id: "manual:item-1",
      inventory_item_id: "item-1",
      environment: "production",
    });
  });
});

describe("processSoldEvent — pre-attributed events skip listing matching", () => {
  function deps(over: Partial<SoldEventDeps> = {}): SoldEventDeps {
    return {
      fetchPending: vi.fn(async () => []),
      matchListing: vi.fn(async () => null),
      claimSale: vi.fn(async () => ({ won: true, remainingQuantity: 0 })),
      endOthers: vi.fn(async () => []),
      markEvent: vi.fn(async () => undefined),
      audit: vi.fn(async () => undefined),
      oversellAction: vi.fn(async () => undefined),
      ...over,
    };
  }

  it("claims + DELISTS from the item id on the event — no listing row needed", async () => {
    const d = deps();
    const evt: SoldEventRow = {
      id: 9,
      user_id: "user-1",
      platform: "facebook",
      external_order_id: "manual:item-1",
      listing_external_id: null,
      sku: null,
      sale_price: 15,
      status: "pending",
      inventory_item_id: "item-1",
    };
    const outcome = await processSoldEvent(evt, d);
    expect(outcome).toBe("processed");
    // Attribution came from the event itself, not from matching.
    expect(d.matchListing).not.toHaveBeenCalled();
    expect(d.claimSale).toHaveBeenCalledWith("item-1", "user-1", "facebook", 15);
    // The cross-channel delist still fires at quantity 0.
    expect(d.endOthers).toHaveBeenCalledWith("user-1", "item-1", "facebook");
  });
});
