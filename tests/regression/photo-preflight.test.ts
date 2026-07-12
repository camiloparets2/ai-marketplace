// Regression: never send eBay an unfetchable image.
//
// Production bug (fix/draft-publish-and-credits, Part 3): the listing-photos
// bucket was private, so getPublicUrl() produced dead /object/public/… URLs
// that returned 503 — and publishes went ahead anyway. The publish path must
// preflight every photo URL and fail with the fix, BEFORE any eBay write.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/connections", () => ({
  getSupabaseAdmin: vi.fn(() => {
    throw new Error("no DB in this test");
  }),
  saveConnection: vi.fn(async () => undefined),
  isExpired: () => false,
}));
vi.mock("@/lib/locations", () => ({
  getShipFromLocation: vi.fn(async () => null),
}));

import { assertPhotosPubliclyReachable } from "@/lib/storage";
import { publishToEbay } from "@/lib/platforms/ebay";
import type { PlatformConnection } from "@/lib/platforms/types";
import type { ListingInput } from "@/lib/platforms/types";

const conn: PlatformConnection = {
  userId: "user-1",
  platform: "ebay",
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  meta: {},
};

const listing: ListingInput = {
  title: "SAKRETE 50 lb Concrete Mix",
  brand: "SAKRETE",
  model: null,
  upc: null,
  condition: "New",
  category: "Home & Garden",
  specs: {},
  price: 24.99,
  shippingCost: 18.4,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(
  handler: (url: string, method: string) => Response | Promise<Response>
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init?.method ?? "GET")
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("assertPhotosPubliclyReachable", () => {
  it("passes for reachable URLs", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(
      assertPhotosPubliclyReachable(["https://cdn.example/a.jpg"])
    ).resolves.toBeUndefined();
  });

  it("fails a 503 (private bucket) with the exact fix in the message", async () => {
    // The live production state: /object/public/… on a private bucket.
    stubFetch(() => new Response(null, { status: 503 }));
    const failure = assertPhotosPubliclyReachable([
      "https://xyz.supabase.co/storage/v1/object/public/listing-photos/x.jpg",
    ]);
    await expect(failure).rejects.toThrow(/publicly reachable/i);
    await expect(failure).rejects.toThrow(/503/);
    await expect(failure).rejects.toThrow(/listing-photos/);
    await expect(failure).rejects.toThrow(/public/i);
  });

  it("falls back to GET when the host rejects HEAD", async () => {
    const spy = stubFetch((_url, method) =>
      method === "HEAD"
        ? new Response(null, { status: 405 })
        : new Response("ok", { status: 200 })
    );
    await expect(
      assertPhotosPubliclyReachable(["https://cdn.example/a.jpg"])
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("fails on network errors, not just HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      })
    );
    await expect(
      assertPhotosPubliclyReachable(["https://gone.example/a.jpg"])
    ).rejects.toThrow(/publicly reachable/i);
  });
});

describe("publishToEbay photo preflight (regression)", () => {
  it("blocks the publish BEFORE any eBay call when a photo URL is dead", async () => {
    const spy = stubFetch((url) => {
      if (url.includes("supabase.co")) return new Response(null, { status: 503 });
      // Any eBay API call reaching fetch means the preflight failed to block.
      throw new Error(`unexpected call past the preflight: ${url}`);
    });

    await expect(
      publishToEbay(
        conn,
        listing,
        ["https://xyz.supabase.co/storage/v1/object/public/listing-photos/x.jpg"],
        "snap-item-1"
      )
    ).rejects.toThrow(/publicly reachable/i);

    // Only the preflight touched the network — no eBay write happened.
    for (const call of spy.mock.calls) {
      expect(String(call[0])).toContain("supabase.co");
    }
  });
});
