// Regression lock for the eBay Marketplace Account Deletion challenge hash.
// eBay validates the endpoint by requiring hex SHA-256 of the concatenation
// IN THIS EXACT ORDER: challengeCode + verificationToken + endpointURL, with
// token and endpoint read from env. A wrong order/encoding fails eBay's
// portal verification, so this test pins all three properties independently
// of the route's own colocated tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/ebay/account-deletion/route";

const TOKEN = "regression-verification-token-0123456789";
const ENDPOINT = "https://ai-marketplace-teal.vercel.app/api/ebay/account-deletion";
const CHALLENGE = "challenge_abc_123";

function sha256Hex(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

function get(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("eBay account-deletion challenge hash (regression)", () => {
  beforeEach(() => {
    process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN = TOKEN;
    process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT = ENDPOINT;
  });
  afterEach(() => {
    delete process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN;
    delete process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT;
  });

  it("returns hex SHA-256 of challengeCode + verificationToken + endpointURL", async () => {
    const res = GET(get(`${ENDPOINT}?challenge_code=${CHALLENGE}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as { challengeResponse: string };
    expect(body.challengeResponse).toBe(sha256Hex(CHALLENGE, TOKEN, ENDPOINT));
    // hex encoding, not base64: 64 lowercase hex chars
    expect(body.challengeResponse).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects every other concatenation order", async () => {
    const res = GET(get(`${ENDPOINT}?challenge_code=${CHALLENGE}`));
    const body = (await res.json()) as { challengeResponse: string };

    const wrongOrders = [
      sha256Hex(TOKEN, CHALLENGE, ENDPOINT),
      sha256Hex(CHALLENGE, ENDPOINT, TOKEN),
      sha256Hex(ENDPOINT, TOKEN, CHALLENGE),
      sha256Hex(TOKEN, ENDPOINT, CHALLENGE),
      sha256Hex(ENDPOINT, CHALLENGE, TOKEN),
    ];
    for (const wrong of wrongOrders) {
      expect(body.challengeResponse).not.toBe(wrong);
    }
  });

  it("reads token and endpoint from env — a changed endpoint changes the hash", async () => {
    const other = "https://other.example/api/ebay/account-deletion";
    process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT = other;

    const res = GET(get(`${other}?challenge_code=${CHALLENGE}`));
    const body = (await res.json()) as { challengeResponse: string };
    expect(body.challengeResponse).toBe(sha256Hex(CHALLENGE, TOKEN, other));
  });
});
