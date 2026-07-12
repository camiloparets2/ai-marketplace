// Draft-time aspect resolution + the category-override publish path
// (sandbox blocker: required aspects with no way to supply them).
//   - getCategoryAspects: full metadata parse, leaf check via null, caching
//   - suggestEbayCategories: id + display name for the picker
//   - publishToEbay: seller-chosen __ebayCategoryId wins over the title
//     suggestion; a stale choice fails LOUDLY; the required-aspect guard
//     still blocks an incomplete item (server-side backstop).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import {
  getCategoryAspects,
  suggestEbayCategories,
  clearAspectCacheForTests,
  publishToEbay,
  buildEbayInventoryItemPayload,
  ebaySkuForItem,
} from "./ebay";
import { EBAY_CATEGORY_SPEC_KEY } from "@/lib/ebay-aspects";
import type { PlatformConnection, ListingInput } from "./types";

const aspectsBody = {
  aspects: [
    {
      localizedAspectName: "Type",
      aspectConstraint: {
        aspectRequired: true,
        aspectMode: "SELECTION_ONLY",
        aspectDataType: "STRING",
      },
      aspectValues: [
        { localizedValue: "Over-Ear" },
        { localizedValue: "In-Ear" },
      ],
    },
    {
      localizedAspectName: "Item Height",
      aspectConstraint: {
        aspectRequired: true,
        aspectMode: "FREE_TEXT",
        aspectDataType: "NUMBER",
      },
    },
    {
      localizedAspectName: "Color",
      aspectConstraint: {
        aspectRequired: false,
        aspectUsage: "RECOMMENDED",
        aspectMode: "FREE_TEXT",
        aspectDataType: "STRING",
      },
    },
  ],
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  clearAspectCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCategoryAspects", () => {
  it("parses required/recommended, mode, data type, and enum values", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(aspectsBody));
    vi.stubGlobal("fetch", fetchImpl);
    const fields = await getCategoryAspects("tok", "0", "112233");
    expect(fields).toEqual([
      {
        name: "Type",
        required: true,
        recommended: false,
        mode: "SELECTION_ONLY",
        dataType: "STRING",
        values: ["Over-Ear", "In-Ear"],
      },
      {
        name: "Item Height",
        required: true,
        recommended: false,
        mode: "FREE_TEXT",
        dataType: "NUMBER",
        values: [],
      },
      {
        name: "Color",
        required: false,
        recommended: true,
        mode: "FREE_TEXT",
        dataType: "STRING",
        values: [],
      },
    ]);
  });

  it("caches per category — the second lookup makes zero network calls", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(aspectsBody));
    vi.stubGlobal("fetch", fetchImpl);
    await getCategoryAspects("tok", "0", "112233");
    await getCategoryAspects("tok", "0", "112233");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null for a non-leaf/retired category (the leaf check)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ errors: [{ message: "not a leaf" }] }, 400))
    );
    expect(await getCategoryAspects("tok", "0", "999")).toBeNull();
  });
});

describe("suggestEbayCategories", () => {
  it("maps id + display name for the picker, capped at 5", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({
          categorySuggestions: Array.from({ length: 8 }, (_, i) => ({
            category: { categoryId: String(i + 1), categoryName: `Cat ${i + 1}` },
          })),
        })
      )
    );
    const options = await suggestEbayCategories("tok", "headphones", "0");
    expect(options).toHaveLength(5);
    expect(options[0]).toEqual({ categoryId: "1", categoryName: "Cat 1" });
  });
});

describe("buildEbayInventoryItemPayload", () => {
  const listing: ListingInput = {
    title: "Sony WH-1000XM4",
    brand: "Sony",
    model: "WH-1000XM4",
    upc: null,
    condition: "Very Good",
    category: "Electronics > Headphones",
    specs: {
      Type: "Over-Ear",
      Unanswered: "  ",
      [EBAY_CATEGORY_SPEC_KEY]: "112233",
    },
    price: 149.99,
    shippingCost: 10.4,
  };

  it("never sends reserved __keys or empty values as aspects", () => {
    const payload = buildEbayInventoryItemPayload(listing, ["https://x/p.jpg"]);
    expect(payload.product.aspects).toEqual({
      Brand: ["Sony"],
      Model: ["WH-1000XM4"],
      Type: ["Over-Ear"],
    });
    expect(
      Object.keys(payload.product.aspects).some((k) => k.startsWith("__"))
    ).toBe(false);
  });
});

// ── publishToEbay with the seller-chosen category ────────────────────────────

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

const baseListing: ListingInput = {
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

// Scripted eBay: records paths; category 555 is the seller's (valid) choice,
// 999 is stale/non-leaf. Aspects require Type + Item Height.
function stubPublishChain(): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const raw = String(url);
      const path = raw.replace(/^https?:\/\/[^/]+/, "");
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (raw.includes("cdn.example")) return new Response(null, { status: 200 });
      if (path.includes("get_category_suggestions")) {
        return jsonRes({
          categorySuggestions: [{ category: { categoryId: "112233", categoryName: "Headphones" } }],
        });
      }
      if (path.includes("get_item_aspects_for_category")) {
        if (path.includes("category_id=999")) {
          return jsonRes({ errors: [{ message: "not a leaf" }] }, 400);
        }
        return jsonRes(aspectsBody);
      }
      if ((init?.method ?? "GET") === "PUT" && path.includes("/inventory_item/")) {
        return new Response(null, { status: 204 });
      }
      if (path.includes("/offer?sku=")) return jsonRes({ offers: [] });
      if ((init?.method ?? "GET") === "POST" && path.endsWith("/offer")) {
        return jsonRes({ offerId: "off-1" }, 201);
      }
      if ((init?.method ?? "GET") === "POST" && path.includes("/publish")) {
        return jsonRes({ listingId: "listing-1" });
      }
      return jsonRes({}, 500);
    })
  );
  return paths;
}

describe("ebay API language headers (Sandbox 400: Invalid value for header Accept-Language)", () => {
  it("sends BOTH Content-Language and Accept-Language, tracking the marketplace", async () => {
    const headerLog: Array<{
      url: string;
      path: string;
      headers: Record<string, string>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const raw = String(url);
        const path = raw.replace(/^https?:\/\/[^/]+/, "");
        headerLog.push({
          url: raw,
          path,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (raw.includes("cdn.example")) return new Response(null, { status: 200 });
        if (path.includes("get_item_aspects_for_category")) return jsonRes(aspectsBody);
        if ((init?.method ?? "GET") === "PUT" && path.includes("/inventory_item/")) {
          return new Response(null, { status: 204 });
        }
        if (path.includes("/offer?sku=")) return jsonRes({ offers: [] });
        if ((init?.method ?? "GET") === "POST" && path.endsWith("/offer")) {
          return jsonRes({ offerId: "off-1" }, 201);
        }
        if ((init?.method ?? "GET") === "POST" && path.includes("/publish")) {
          return jsonRes({ listingId: "listing-1" });
        }
        return jsonRes({}, 500);
      })
    );

    // A GERMAN seller: both headers must be de-DE, proving the language
    // tracks the marketplace and is never a hardcoded en-US (and never left
    // to an ambient runtime default, which eBay 400s with errorId 25709).
    const deConn: PlatformConnection = {
      ...conn,
      meta: { ...conn.meta, marketplaceId: "EBAY_DE", currency: "EUR" },
    };
    await publishToEbay(
      deConn,
      {
        ...baseListing,
        specs: {
          Type: "Over-Ear",
          "Item Height": "8 in",
          [EBAY_CATEGORY_SPEC_KEY]: "555",
        },
      },
      ["https://cdn.example/p.jpg"],
      ebaySkuForItem("item-1")
    );

    const itemPut = headerLog.find((c) => c.path.includes("/inventory_item/"));
    expect(itemPut).toBeDefined();
    expect(itemPut?.headers["Content-Language"]).toBe("de-DE");
    expect(itemPut?.headers["Accept-Language"]).toBe("de-DE");

    // Every eBay API call carries an EXPLICIT Accept-Language — nothing
    // ambient (the photo-preflight HEAD to the CDN is not an eBay call).
    for (const call of headerLog.filter((c) => !c.url.includes("cdn.example"))) {
      expect(call.headers["Accept-Language"]).toBeTruthy();
    }
  });
});

describe("publishToEbay category override + aspect backstop", () => {
  const complete: ListingInput = {
    ...baseListing,
    specs: {
      Type: "Over-Ear",
      "Item Height": "8 in",
      [EBAY_CATEGORY_SPEC_KEY]: "555",
    },
  };

  it("uses the seller-chosen leaf category — no title re-suggestion", async () => {
    const paths = stubPublishChain();
    const result = await publishToEbay(
      conn,
      complete,
      ["https://cdn.example/p.jpg"],
      ebaySkuForItem("item-1")
    );
    expect(result.listingId).toBe("listing-1");
    expect(paths.some((p) => p.includes("category_id=555"))).toBe(true);
    expect(paths.some((p) => p.includes("get_category_suggestions"))).toBe(false);
    // The offer carries the chosen category.
    const offerPost = paths.find((p) => p.startsWith("POST") && p.endsWith("/offer"));
    expect(offerPost).toBeDefined();
  });

  it("still BLOCKS publish when a required aspect is missing (backstop)", async () => {
    stubPublishChain();
    const incomplete: ListingInput = {
      ...baseListing,
      specs: { Type: "Over-Ear", [EBAY_CATEGORY_SPEC_KEY]: "555" },
    };
    await expect(
      publishToEbay(conn, incomplete, ["https://cdn.example/p.jpg"], ebaySkuForItem("item-1"))
    ).rejects.toThrow(/Item Height/);
  });

  it("fails LOUDLY on a stale chosen category — never silently re-routes", async () => {
    stubPublishChain();
    const stale: ListingInput = {
      ...baseListing,
      specs: {
        Type: "Over-Ear",
        "Item Height": "8 in",
        [EBAY_CATEGORY_SPEC_KEY]: "999",
      },
    };
    await expect(
      publishToEbay(conn, stale, ["https://cdn.example/p.jpg"], ebaySkuForItem("item-1"))
    ).rejects.toThrow(/no longer a valid leaf/i);
  });
});
