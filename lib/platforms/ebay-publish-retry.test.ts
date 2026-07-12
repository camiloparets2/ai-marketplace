// Deterministic-SKU retry safety (launch-hardening Phase 2): retrying a
// publish must NEVER create a duplicate eBay listing. The SKU derives from
// the inventory item, the inventory PUT is an idempotent upsert, and the
// offer is looked up by SKU + marketplace before any create:
//   - already PUBLISHED → return the live listing, zero writes
//   - exists unpublished → update THAT offer, then publish it
//   - missing → create, with adopt-on-race fallback
// Exercises the real publishToEbay against a scripted fetch — no network.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/connections", () => ({
  saveConnection: vi.fn(async () => undefined),
  isExpired: () => false,
  getSupabaseAdmin: vi.fn(() => {
    throw new Error("no DB in this test");
  }),
}));
vi.mock("@/lib/locations", () => ({
  getShipFromLocation: vi.fn(async () => null),
}));

import { publishToEbay, ebaySkuForItem } from "./ebay";
import type { PlatformConnection, ListingInput } from "./types";

const SKU = ebaySkuForItem("item-1");

// Connection with everything cached in meta so the flow needs no
// location/policy detection: only item PUT, offer lookup/create, publish.
const conn: PlatformConnection = {
  userId: "user-1",
  platform: "ebay",
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  meta: {
    ebayUserId: "ebay-user-1",
    merchantLocationKey: "loc-1",
    marketplaceId: "EBAY_US",
    currency: "USD",
    fulfillmentPolicyId: "f1",
    paymentPolicyId: "p1",
    returnPolicyId: "r1",
  },
};

const listing: ListingInput = {
  title: "Sony WH-1000XM4 Wireless Headphones",
  brand: "Sony",
  model: "WH-1000XM4",
  upc: null,
  condition: "Very Good",
  category: "Electronics > Headphones",
  specs: {},
  price: 149.99,
  shippingCost: 10.4,
};

interface Recorded {
  path: string;
  method: string;
}

function stubEbay(
  offerLookup: () => Response,
  overrides: Partial<Record<string, () => Response>> = {}
): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const raw = String(url);
      const path = raw.replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      calls.push({ path, method });

      // Photo preflight (HEAD to the CDN).
      if (raw.includes("cdn.example")) return new Response(null, { status: 200 });
      // Category suggestion.
      if (path.includes("get_category_suggestions")) {
        return new Response(
          JSON.stringify({
            categorySuggestions: [{ category: { categoryId: "112233" } }],
          }),
          { status: 200 }
        );
      }
      // Inventory item upsert.
      if (method === "PUT" && path.includes("/inventory_item/")) {
        return new Response(null, { status: 204 });
      }
      // Offer lookup by SKU.
      if (method === "GET" && path.includes("/offer?sku=")) {
        return offerLookup();
      }
      for (const [key, maker] of Object.entries(overrides)) {
        if (path.includes(key) && maker) return maker();
      }
      // Offer create.
      if (method === "POST" && path.endsWith("/offer")) {
        return new Response(JSON.stringify({ offerId: "off-new" }), {
          status: 201,
        });
      }
      // Offer update.
      if (method === "PUT" && path.includes("/offer/")) {
        return new Response(null, { status: 204 });
      }
      // Publish.
      if (method === "POST" && path.includes("/publish")) {
        return new Response(JSON.stringify({ listingId: "listing-9" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 500 });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishToEbay retry safety (deterministic SKU)", () => {
  it("derives the SKU from the inventory item, under eBay's 50-char cap", () => {
    const sku = ebaySkuForItem("123e4567-e89b-42d3-a456-426614174000");
    expect(sku).toBe("snap-123e4567-e89b-42d3-a456-426614174000");
    expect(sku.length).toBeLessThanOrEqual(50);
    // Same item → same SKU, every time.
    expect(ebaySkuForItem("item-1")).toBe(ebaySkuForItem("item-1"));
  });

  it("returns the existing LIVE listing instead of creating a duplicate", async () => {
    const calls = stubEbay(() =>
      new Response(
        JSON.stringify({
          offers: [
            {
              offerId: "off-1",
              marketplaceId: "EBAY_US",
              status: "PUBLISHED",
              listing: { listingId: "listing-1" },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await publishToEbay(conn, listing, ["https://cdn.example/p.jpg"], SKU);
    expect(result).toMatchObject({
      listingId: "listing-1",
      offerId: "off-1",
      sku: SKU,
    });
    // No offer create, no publish — nothing to duplicate.
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/offer"))).toBe(false);
    expect(calls.some((c) => c.path.includes("/publish"))).toBe(false);
  });

  it("reuses an existing UNPUBLISHED offer — update + publish, never a second create", async () => {
    const calls = stubEbay(() =>
      new Response(
        JSON.stringify({
          offers: [
            { offerId: "off-2", marketplaceId: "EBAY_US", status: "UNPUBLISHED" },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await publishToEbay(conn, listing, ["https://cdn.example/p.jpg"], SKU);
    expect(result).toMatchObject({ listingId: "listing-9", offerId: "off-2" });
    expect(calls.some((c) => c.method === "PUT" && c.path.includes("/offer/off-2"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/offer"))).toBe(false);
  });

  it("creates the offer when none exists (404 lookup) and publishes it", async () => {
    const calls = stubEbay(() => new Response(null, { status: 404 }));
    const result = await publishToEbay(conn, listing, ["https://cdn.example/p.jpg"], SKU);
    expect(result).toMatchObject({ listingId: "listing-9", offerId: "off-new" });
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/offer"))).toBe(true);
  });
});
