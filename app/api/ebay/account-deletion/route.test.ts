import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

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
  it("ACKs a valid deletion notification with 200", async () => {
    const req = new NextRequest(
      new Request("https://example.com/api/ebay/account-deletion", {
        method: "POST",
        body: JSON.stringify({
          metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
          notification: {
            notificationId: "n-1",
            data: { username: "someuser", userId: "u-99" },
          },
        }),
      })
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("400s on malformed JSON so eBay retries", async () => {
    const req = new NextRequest(
      new Request("https://example.com/api/ebay/account-deletion", {
        method: "POST",
        body: "not json",
      })
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("still ACKs when the notification has no data block", async () => {
    const req = new NextRequest(
      new Request("https://example.com/api/ebay/account-deletion", {
        method: "POST",
        body: JSON.stringify({ notification: { notificationId: "n-2" } }),
      })
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

// Keep the console quiet during the intentional error-path tests.
vi.spyOn(console, "error").mockImplementation(() => undefined);
vi.spyOn(console, "log").mockImplementation(() => undefined);
