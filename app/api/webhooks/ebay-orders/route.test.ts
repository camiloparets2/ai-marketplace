import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/platforms/ebay-signature", () => ({
  verifyEbaySignature: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/notification-receipts", () => ({
  notificationAlreadyProcessed: vi.fn(async () => false),
  markNotificationProcessed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/sold-events", () => ({
  recordSoldEvent: vi.fn().mockResolvedValue(1),
  findListingOwner: vi
    .fn()
    .mockResolvedValue({ userId: "user-1", inventoryItemId: "item-1" }),
  processPendingSoldEvents: vi
    .fn()
    .mockResolvedValue({ processed: 1, oversold: 0, unmatched: 0, errors: 0 }),
}));

import { GET, POST } from "./route";
import {
  recordSoldEvent,
  findListingOwner,
  processPendingSoldEvents,
} from "@/lib/sold-events";
import { verifyEbaySignature } from "@/lib/platforms/ebay-signature";
import { notificationAlreadyProcessed } from "@/lib/notification-receipts";

const TOKEN = "order-webhook-verification-token-1234567890";
const ENDPOINT = "https://app.example.com/api/webhooks/ebay-orders";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EBAY_ORDER_WEBHOOK_VERIFICATION_TOKEN = TOKEN;
  process.env.EBAY_ORDER_WEBHOOK_ENDPOINT = ENDPOINT;
});

function getReq(challenge: string | null): NextRequest {
  const url = new URL(ENDPOINT);
  if (challenge !== null) url.searchParams.set("challenge_code", challenge);
  return new NextRequest(url);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest(ENDPOINT, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("GET challenge", () => {
  it("returns sha256(challengeCode + verificationToken + endpoint) hex — exactly that order", async () => {
    const res = GET(getReq("code-123"));
    expect(res.status).toBe(200);
    const { challengeResponse } = (await res.json()) as {
      challengeResponse: string;
    };
    const expected = createHash("sha256")
      .update("code-123")
      .update(TOKEN)
      .update(ENDPOINT)
      .digest("hex");
    expect(challengeResponse).toBe(expected);
  });

  it("400s without a challenge code and 500s when unconfigured", async () => {
    expect(GET(getReq(null)).status).toBe(400);
    delete process.env.EBAY_ORDER_WEBHOOK_VERIFICATION_TOKEN;
    expect(GET(getReq("code-123")).status).toBe(500);
  });
});

describe("POST order notification", () => {
  const notification = {
    notification: {
      notificationId: "n-1",
      data: {
        orderId: "ord-42",
        lineItems: [
          { legacyItemId: "listing-100", sku: "snap-1", total: { value: "49.99" } },
        ],
      },
    },
  };

  it("normalizes each sold line into the queue and drains for the seller", async () => {
    const res = await POST(postReq(notification));
    expect(res.status).toBe(200);

    expect(findListingOwner).toHaveBeenCalledWith("ebay", "listing-100", "snap-1");
    expect(recordSoldEvent).toHaveBeenCalledWith({
      userId: "user-1",
      platform: "ebay",
      externalOrderId: "ord-42",
      listingExternalId: "listing-100",
      sku: "snap-1",
      salePrice: 49.99,
      source: "webhook",
      raw: { notificationId: "n-1" },
    });
    expect(processPendingSoldEvents).toHaveBeenCalledWith("user-1");
  });

  it("ACKs 200 on unparseable payloads without enqueuing (polling is the backstop)", async () => {
    const res = await POST(postReq({ metadata: { topic: "something-else" } }));
    expect(res.status).toBe(200);
    expect(recordSoldEvent).not.toHaveBeenCalled();
  });

  it("skips lines whose listing we never published", async () => {
    vi.mocked(findListingOwner).mockResolvedValueOnce(null);
    const res = await POST(postReq(notification));
    expect(res.status).toBe(200);
    expect(recordSoldEvent).not.toHaveBeenCalled();
  });

  it("returns 500 when enqueuing fails so eBay retries", async () => {
    vi.mocked(recordSoldEvent).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(postReq(notification));
    expect(res.status).toBe(500);
  });

  it("400s on malformed JSON", async () => {
    const req = new NextRequest(ENDPOINT, { method: "POST", body: "{nope" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});


describe("POST signature enforcement", () => {
  it("412s an invalid signature and never touches the queue", async () => {
    vi.mocked(verifyEbaySignature).mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      detail: "signature mismatch",
    });
    const res = await POST(
      postReq({ notification: { notificationId: "n-sig", data: {} } })
    );
    expect(res.status).toBe(412);
    expect(recordSoldEvent).not.toHaveBeenCalled();
  });

  it("503s when key infrastructure is down so eBay redelivers", async () => {
    vi.mocked(verifyEbaySignature).mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      detail: "key endpoint down",
    });
    const res = await POST(
      postReq({ notification: { notificationId: "n-sig2", data: {} } })
    );
    expect(res.status).toBe(503);
    expect(recordSoldEvent).not.toHaveBeenCalled();
  });

  it("ACKs an already-processed notification without reprocessing", async () => {
    vi.mocked(notificationAlreadyProcessed).mockResolvedValueOnce(true);
    const res = await POST(
      postReq({
        notification: {
          notificationId: "n-dupe",
          data: {
            orderId: "o-1",
            lineItems: [{ legacyItemId: "l-1", total: { value: "10.00" } }],
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(recordSoldEvent).not.toHaveBeenCalled();
  });
});
