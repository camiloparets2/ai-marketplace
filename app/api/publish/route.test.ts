// /api/publish maps the seller-readiness onboarding error to an actionable
// CTA (docs/design/ebay-seller-readiness.md): a non-registered seller gets
// "Finish your eBay seller setup →", never eBay's raw 400. Credits are not
// involved anywhere in this route (they're spent at /api/analyze), so a
// failed publish can never consume one — this file's mocks would fail on any
// billing import.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => "allowed"),
  requestIdentity: vi.fn(() => "user-1"),
  RATE_RULES: { publish: { limit: 10, windowSeconds: 60 } },
  RATE_LIMIT_UNAVAILABLE_MESSAGE: "rate limiter unavailable",
}));
vi.mock("@/lib/connections", () => ({
  getConnection: vi.fn(async () => ({
    userId: "user-1",
    platform: "ebay",
    accessToken: "tok",
    refreshToken: null,
    expiresAt: null,
    meta: {},
  })),
}));
vi.mock("@/lib/storage", () => ({
  hostListingPhoto: vi.fn(async () => "https://cdn.example/photo.jpg"),
}));
vi.mock("@/lib/inventory", () => ({
  createInventoryItem: vi.fn(async () => "item-1"),
  recordLiveListing: vi.fn(async () => undefined),
  recordPublishAttempt: vi.fn(async () => undefined),
  beginPublishAttempt: vi.fn(async () => "attempt-1"),
  completePublishAttempt: vi.fn(async () => true),
  markItemListed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/telemetry", () => ({
  trackEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/stripe-link", () => ({
  createPaymentLink: vi.fn(async () => ({ url: "https://pay", id: "pl_1" })),
}));
// Keep the real error classes/constants; only the publish call is faked.
vi.mock("@/lib/platforms/ebay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platforms/ebay")>();
  return { ...actual, publishToEbay: vi.fn() };
});

import { POST } from "./route";
import {
  publishToEbay,
  EbaySellerSetupError,
  EBAY_SELLER_REGISTRATION_URL,
} from "@/lib/platforms/ebay";

// Minimal bytes that pass validateImageBytes: JPEG magic, ≥12 bytes.
function jpegBase64(): string {
  const bytes = Buffer.alloc(16);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.toString("base64");
}

function publishRequest(): NextRequest {
  return new NextRequest("https://app.example.com/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      listing: {
        title: "Sony WH-1000XM4 Wireless Headphones",
        brand: "Sony",
        model: null,
        upc: null,
        condition: "Good",
        category: "Electronics > Headphones",
        specs: {},
        price: 149.99,
        shippingCost: null,
      },
      image: jpegBase64(),
      mimeType: "image/jpeg",
      targets: ["ebay"],
    }),
  });
}

beforeEach(() => {
  vi.mocked(publishToEbay).mockReset();
});

describe("POST /api/publish — eBay seller readiness", () => {
  it("maps a non-registered seller to the registration CTA, never the raw 400", async () => {
    vi.mocked(publishToEbay).mockRejectedValue(
      new EbaySellerSetupError("not_registered")
    );

    const res = await POST(publishRequest());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{
        platform: string;
        status: string;
        message?: string;
        actionUrl?: string;
        actionLabel?: string;
      }>;
    };

    const ebay = data.results.find((r) => r.platform === "ebay");
    expect(ebay).toMatchObject({
      status: "error",
      actionUrl: EBAY_SELLER_REGISTRATION_URL,
    });
    expect(ebay?.actionLabel).toMatch(/seller setup/i);
    // Plain English, no eBay API jargon or status codes.
    expect(ebay?.message).not.toMatch(/400|not eligible|business policy lookup/i);
    expect(ebay?.message).toMatch(/seller registration/i);
  });

  it("maps a still-activating policy program to a retry message without the CTA", async () => {
    vi.mocked(publishToEbay).mockRejectedValue(
      new EbaySellerSetupError("policies_pending")
    );

    const res = await POST(publishRequest());
    const data = (await res.json()) as {
      results: Array<{ status: string; message?: string; actionUrl?: string }>;
    };
    expect(data.results[0].status).toBe("error");
    expect(data.results[0].actionUrl).toBeUndefined();
    expect(data.results[0].message).toMatch(/few minutes|shortly/i);
  });
});

describe("POST /api/publish — fail-closed auth and rate limiting", () => {
  it("401s without a session — no beta-key path exists anymore", async () => {
    const { requireUser } = await import("@/lib/auth/guard");
    vi.mocked(requireUser).mockResolvedValueOnce(null);
    const res = await POST(publishRequest());
    expect(res.status).toBe(401);
    expect(publishToEbay).not.toHaveBeenCalled();
  });

  it("503s (retriable) when the rate limiter is unavailable — publish never runs", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");
    vi.mocked(checkRateLimit).mockResolvedValueOnce("unavailable");
    const res = await POST(publishRequest());
    expect(res.status).toBe(503);
    expect(publishToEbay).not.toHaveBeenCalled();
  });
});

describe("POST /api/publish — shippingCost validation (money rule)", () => {
  function requestWithShipping(shippingCost: unknown): NextRequest {
    return new NextRequest("https://app.example.com/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        listing: {
          title: "Sony WH-1000XM4 Wireless Headphones",
          brand: "Sony",
          model: null,
          upc: null,
          condition: "Good",
          category: "Electronics > Headphones",
          specs: {},
          price: 149.99,
          shippingCost,
        },
        image: jpegBase64(),
        mimeType: "image/jpeg",
        targets: ["ebay"],
      }),
    });
  }

  // Previously UNVALIDATED: a malformed client value could store a bogus
  // $0 = silent free shipping the seller absorbs (the concrete-bag bug).
  it.each([
    ["a string", "free"],
    ["a negative number", -3],
    ["an object", {}],
    ["missing entirely", undefined],
  ])("rejects shippingCost that is %s — nothing publishes", async (_label, value) => {
    const res = await POST(requestWithShipping(value));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/shippingCost/);
    expect(publishToEbay).not.toHaveBeenCalled();
  });
});
