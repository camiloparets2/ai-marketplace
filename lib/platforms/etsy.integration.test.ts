// Integration harness for the Etsy pipeline: the REAL lib/platforms/etsy.ts
// code runs against a faithful in-memory mock of Etsy's v3 API, asserting
// every request our code emits (paths, auth headers, JSON bodies, multipart
// photo upload, call ordering) and every response path we handle. This is
// the maximum executable verification without the live API key + a human on
// the consent screen — it catches wiring bugs (field names, sequencing,
// headers), not credential problems.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// etsy.ts persists refreshed tokens / cached shop ids via lib/connections —
// stub the store, keep the real expiry logic.
const saveConnection = vi.fn();
vi.mock("@/lib/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connections")>();
  return {
    ...actual,
    saveConnection: (...args: unknown[]) => saveConnection(...args),
    getSupabaseAdmin: () => {
      throw new Error("test must not touch Supabase");
    },
  };
});

import {
  etsyAuthorizeUrl,
  generatePkce,
  publishToEtsy,
  endEtsyListing,
  fetchEtsySales,
} from "@/lib/platforms/etsy";
import type { ListingInput, PlatformConnection } from "@/lib/platforms/types";
import { createHash } from "crypto";

// ─── The mock Etsy server ─────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  isFormData?: boolean;
  formFileName?: string;
}

const calls: RecordedCall[] = [];

// Per-test behavior switches
const mock = {
  shippingProfiles: [{ shipping_profile_id: 1010 }] as Array<{
    shipping_profile_id: number;
  }>,
  activateFails: false,
  endStatus: 200,
};

// Realistic seller-taxonomy shape: matcher should pick the deep
// "Headphones" node for our "Electronics > Headphones" category.
const TAXONOMY = {
  results: [
    { id: 1, name: "Accessories", children: [{ id: 12, name: "Phone Cases" }] },
    { id: 2, name: "Electronics", children: [{ id: 21, name: "Headphones" }] },
  ],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function route(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(
    Object.entries((init?.headers as Record<string, string>) ?? {})
  );

  const call: RecordedCall = { method, path: u.pathname + u.search, headers };
  if (typeof init?.body === "string") {
    call.json = JSON.parse(init.body) as Record<string, unknown>;
  } else if (init?.body instanceof FormData) {
    call.isFormData = true;
    const file = init.body.get("image");
    call.formFileName = file instanceof File ? file.name : undefined;
  }
  calls.push(call);

  const p = u.pathname;
  if (p === "/v3/public/oauth/token") {
    return json(200, {
      access_token: "refreshed-token",
      refresh_token: "refreshed-refresh",
      expires_in: 3600,
    });
  }
  if (p === "/v3/application/users/me") {
    return json(200, { user_id: 42, shop_id: 777 });
  }
  if (p === "/v3/application/shops/777/shipping-profiles") {
    return json(200, { results: mock.shippingProfiles });
  }
  if (p === "/v3/application/seller-taxonomy/nodes") {
    return json(200, TAXONOMY);
  }
  if (p === "/v3/application/shops/777/listings" && method === "POST") {
    return json(201, { listing_id: 555001 });
  }
  if (p === "/v3/application/shops/777/listings/555001/images") {
    return json(201, { listing_image_id: 9001 });
  }
  if (p === "/v3/application/shops/777/listings/555001" && method === "PATCH") {
    const body = call.json as { state?: string };
    if (body.state === "active" && mock.activateFails) {
      return json(400, { error: "Listing cannot be activated" });
    }
    if (body.state === "inactive") {
      return new Response(null, { status: mock.endStatus });
    }
    return json(200, { listing_id: 555001, state: body.state });
  }
  return json(404, { error: `unmocked: ${method} ${p}` });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT: ListingInput = {
  title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones",
  brand: "Sony",
  model: "WH-1000XM4",
  upc: "027242919952",
  condition: "Very Good",
  category: "Electronics > Headphones",
  specs: { Color: "Black" },
  price: 179.99,
  shippingCost: 10.4,
};

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]);

function connection(overrides: Partial<PlatformConnection> = {}): PlatformConnection {
  return {
    userId: "user-1",
    platform: "etsy",
    accessToken: "live-token",
    refreshToken: "live-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    meta: { shopId: "777" },
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  saveConnection.mockReset();
  mock.shippingProfiles = [{ shipping_profile_id: 1010 }];
  mock.activateFails = false;
  mock.endStatus = 200;
  process.env.ETSY_API_KEY = "test-keystring";
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) =>
    route(String(url), init)
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ETSY_API_KEY;
});

// ─── OAuth handoff ────────────────────────────────────────────────────────────

describe("Etsy OAuth handoff", () => {
  it("builds a spec-compliant consent URL (%20 scopes, PKCE, redirect)", () => {
    const { verifier, challenge } = generatePkce();
    const url = etsyAuthorizeUrl("state123", challenge, "https://app.example");

    expect(url.startsWith("https://www.etsy.com/oauth/connect?")).toBe(true);
    expect(url).toContain(
      "scope=listings_w%20listings_r%20shops_r%20transactions_r"
    );
    expect(url).not.toContain("+"); // the URLSearchParams footgun
    expect(url).toContain(
      `redirect_uri=${encodeURIComponent("https://app.example/api/oauth/etsy/callback")}`
    );
    expect(url).toContain(`code_challenge=${challenge}`);
    expect(url).toContain("code_challenge_method=S256");

    // PKCE pair is genuine S256
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
});

// ─── Full publish pipeline ────────────────────────────────────────────────────

describe("publishToEtsy against the mock API", () => {
  it("runs draft → photo upload → activate and returns the live listing", async () => {
    const result = await publishToEtsy(connection(), INPUT, PHOTO, "image/jpeg");

    expect(result).toEqual({
      url: "https://www.etsy.com/listing/555001",
      listingId: "555001",
      shopId: "777",
    });

    // Every call carries both auth headers Etsy requires
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBe("test-keystring");
      expect(c.headers["Authorization"]).toBe("Bearer live-token");
    }

    // Draft creation body: exact field-level contract with Etsy v3
    const create = calls.find(
      (c) => c.method === "POST" && c.path === "/v3/application/shops/777/listings"
    );
    expect(create).toBeDefined();
    expect(create?.json).toMatchObject({
      quantity: 1,
      title: INPUT.title,
      price: 179.99,
      who_made: "someone_else",
      when_made: "2010_2019",
      taxonomy_id: 21, // deep "Headphones" node beat shallow matches
      shipping_profile_id: 1010,
      type: "physical",
      state: "draft",
    });
    const tags = create?.json?.tags as string[];
    expect(tags.length).toBeLessThanOrEqual(13);
    expect(tags).toContain("Sony");

    // Photo goes up as multipart with NO manual content-type (fetch must
    // set the boundary itself)
    const upload = calls.find((c) => c.path.endsWith("/images"));
    expect(upload?.isFormData).toBe(true);
    expect(upload?.headers["Content-Type"]).toBeUndefined();
    expect(upload?.formFileName).toBe("photo.jpg");

    // Ordering: draft before upload before activate
    const order = calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    const iCreate = order.indexOf("POST /v3/application/shops/777/listings");
    const iUpload = order.indexOf(
      "POST /v3/application/shops/777/listings/555001/images"
    );
    const iActivate = order.lastIndexOf(
      "PATCH /v3/application/shops/777/listings/555001"
    );
    expect(iCreate).toBeGreaterThan(-1);
    expect(iUpload).toBeGreaterThan(iCreate);
    expect(iActivate).toBeGreaterThan(iUpload);

    // Activation flips the draft live
    expect(calls[iActivate].json).toEqual({ state: "active" });
  });

  it("surfaces a draft-preserved message when activation fails", async () => {
    mock.activateFails = true;
    await expect(
      publishToEtsy(connection(), INPUT, PHOTO, "image/jpeg")
    ).rejects.toThrow(/draft was saved/i);
  });

  it("explains the fix when the shop has no shipping profile", async () => {
    mock.shippingProfiles = [];
    await expect(
      publishToEtsy(connection(), INPUT, PHOTO, "image/jpeg")
    ).rejects.toThrow(/no shipping profile/i);
  });

  it("refreshes an expired token first and persists it", async () => {
    const result = await publishToEtsy(
      connection({ expiresAt: Date.now() - 1000 }),
      INPUT,
      PHOTO,
      "image/jpeg"
    );
    expect(result.listingId).toBe("555001");

    expect(calls[0].path).toBe("/v3/public/oauth/token");
    expect(calls[0].json).toMatchObject({
      grant_type: "refresh_token",
      client_id: "test-keystring",
      refresh_token: "live-refresh",
    });
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "refreshed-token" })
    );
    // Subsequent calls use the refreshed bearer
    expect(calls[1].headers["Authorization"]).toBe("Bearer refreshed-token");
  });

  it("resolves and caches the shop id when the connection lacks it", async () => {
    const result = await publishToEtsy(
      connection({ meta: {} }),
      INPUT,
      PHOTO,
      "image/jpeg"
    );
    expect(result.shopId).toBe("777");
    expect(calls.some((c) => c.path === "/v3/application/users/me")).toBe(true);
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ shopId: "777" }) })
    );
  });
});

// ─── Sold-elsewhere delist + sales polling ────────────────────────────────────

describe("endEtsyListing / fetchEtsySales against the mock API", () => {
  it("deactivates a live listing", async () => {
    await endEtsyListing(connection(), "777", "555001");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.json).toEqual({ state: "inactive" });
  });

  it("treats an already-gone listing (404) as ended", async () => {
    mock.endStatus = 404;
    await expect(
      endEtsyListing(connection(), "777", "555001")
    ).resolves.toBeUndefined();
  });

  it("polls receipts with min_created and parses paid sales", async () => {
    vi.stubGlobal("fetch", (url: string | URL) => {
      const u = new URL(String(url));
      calls.push({ method: "GET", path: u.pathname + u.search, headers: {} });
      if (u.pathname === "/v3/application/shops/777/receipts") {
        return Promise.resolve(
          json(200, {
            results: [
              {
                receipt_id: 9,
                is_paid: true,
                grandtotal: { amount: 17999, divisor: 100 },
                transactions: [{ listing_id: 555001, price: { amount: 17999, divisor: 100 } }],
              },
            ],
          })
        );
      }
      return Promise.resolve(json(404, {}));
    });

    const sales = await fetchEtsySales(connection(), 1_700_000_000);
    expect(calls.at(-1)?.path).toContain("min_created=1700000000");
    expect(sales).toEqual([
      { receiptId: "9", listingId: "555001", price: 179.99 },
    ]);
  });
});
