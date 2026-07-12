import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/platforms/ebay-signature", () => ({
  verifyEbaySignature: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/notification-receipts", () => ({
  notificationAlreadyProcessed: vi.fn(async () => false),
  markNotificationProcessed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/platforms/ebay-deletion", () => ({
  handleEbayAccountDeletion: vi.fn(async () => ({
    deletedConnections: 1,
    scrubbedListings: 0,
    scrubbedAttempts: 0,
    scrubbedSoldEvents: 0,
    scrubbedAuditRows: 0,
  })),
}));

import { GET, POST } from "./route";
import { handleEbayAccountDeletion } from "@/lib/platforms/ebay-deletion";
import { verifyEbaySignature } from "@/lib/platforms/ebay-signature";

// The three inputs eBay hashes, in the exact mandated order.
const TOKEN = "test-verification-token-1234567890";
const ENDPOINT = "https://example.com/api/ebay/account-deletion";

function makeGet(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("eBay account deletion — GET challenge", () => {
  beforeEach(() => {
    process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN = TOKEN;
    process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT = ENDPOINT;
  });
  afterEach(() => {
    delete process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN;
    delete process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT;
  });

  it("hashes challengeCode + verificationToken + endpoint in that order", async () => {
    const challenge = "abc123";
    const expected = createHash("sha256")
      .update(challenge)
      .update(TOKEN)
      .update(ENDPOINT)
      .digest("hex");

    const res = GET(
      makeGet(
        `https://example.com/api/ebay/account-deletion?challenge_code=${challenge}`
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ challengeResponse: expected });
  });

  it("order matters — a different concatenation order would not match", async () => {
    const challenge = "abc123";
    const wrongOrder = createHash("sha256")
      .update(TOKEN)
      .update(challenge)
      .update(ENDPOINT)
      .digest("hex");

    const res = GET(
      makeGet(
        `https://example.com/api/ebay/account-deletion?challenge_code=${challenge}`
      )
    );
    const body = (await res.json()) as { challengeResponse: string };
    expect(body.challengeResponse).not.toBe(wrongOrder);
  });

  it("400s when challenge_code is missing", () => {
    const res = GET(makeGet("https://example.com/api/ebay/account-deletion"));
    expect(res.status).toBe(400);
  });

  it("500s (without leaking secrets) when not configured", async () => {
    delete process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN;
    const res = GET(
      makeGet(
        "https://example.com/api/ebay/account-deletion?challenge_code=x"
      )
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(ENDPOINT);
  });
});

describe("eBay account deletion — POST notification", () => {
  function post(body: unknown): NextRequest {
    return new NextRequest(
      new Request("https://example.com/api/ebay/account-deletion", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  }

  beforeEach(() => {
    vi.mocked(handleEbayAccountDeletion).mockClear();
    vi.mocked(handleEbayAccountDeletion).mockResolvedValue({
      deletedConnections: 1,
      scrubbedListings: 0,
      scrubbedAttempts: 0,
      scrubbedSoldEvents: 0,
      scrubbedAuditRows: 0,
    });
  });

  it("ACKs a valid deletion notification with 200 after erasing", async () => {
    const res = await POST(
      post({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: {
          notificationId: "n-1",
          data: { username: "someuser", userId: "u-99" },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(handleEbayAccountDeletion).toHaveBeenCalledWith({
      userId: "u-99",
      username: "someuser",
      notificationId: "n-1",
    });
  });

  it("400s on malformed JSON so eBay retries", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(handleEbayAccountDeletion).not.toHaveBeenCalled();
  });

  it("400s when the notification has no data block — never a silent success", async () => {
    const res = await POST(
      post({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: { notificationId: "n-2" },
      })
    );
    expect(res.status).toBe(400);
    expect(handleEbayAccountDeletion).not.toHaveBeenCalled();
  });

  it("400s on a topic mismatch", async () => {
    const res = await POST(
      post({
        metadata: { topic: "SOMETHING_ELSE" },
        notification: { notificationId: "n-3", data: { userId: "u-1" } },
      })
    );
    expect(res.status).toBe(400);
    expect(handleEbayAccountDeletion).not.toHaveBeenCalled();
  });

  it("412s an invalid signature before parsing anything", async () => {
    vi.mocked(verifyEbaySignature).mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      detail: "missing X-EBAY-SIGNATURE",
    });
    const res = await POST(
      post({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: { notificationId: "n-sig", data: { userId: "u-1" } },
      })
    );
    expect(res.status).toBe(412);
    expect(handleEbayAccountDeletion).not.toHaveBeenCalled();
  });

  it("500s when erasure fails so eBay RETRIES — no acked-but-not-erased", async () => {
    vi.mocked(handleEbayAccountDeletion).mockRejectedValueOnce(
      new Error("db down")
    );
    const res = await POST(
      post({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: { notificationId: "n-4", data: { userId: "u-99" } },
      })
    );
    expect(res.status).toBe(500);
  });
});

// Keep the console quiet during the intentional error-path tests.
vi.spyOn(console, "error").mockImplementation(() => undefined);
vi.spyOn(console, "log").mockImplementation(() => undefined);
