// Regression: /api/analyze fails CLOSED (launch-hardening Phase 1.4).
//
// The route previously honored a browser-shipped pre-shared beta key and
// "failed open" when billing or rate limiting was unavailable — an
// unauthenticated, unmetered path straight to a paid Claude call. Pins:
//   1. no session → 401, Claude never called (no beta-key fallback exists)
//   2. rate limiter unavailable → retriable 503, Claude never called
//   3. credit ledger unavailable → retriable 503, Claude never called
//   4. happy path still works and spends exactly one credit

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => "allowed"),
  requestIdentity: vi.fn(() => "user:user-1"),
  RATE_RULES: { analyze: { name: "analyze", windowSecs: 3600, max: 60 } },
  RATE_LIMIT_UNAVAILABLE_MESSAGE: "rate limiter unavailable — retry",
}));
vi.mock("@/lib/billing/credits", () => ({
  spendCredits: vi.fn(async () => ({ ok: true, remaining: 9 })),
  refundCredits: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/vision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/vision")>();
  return {
    ...actual,
    identifyItem: vi.fn(async () => ({
      extraction: {
        title: "Test Item",
        suggestedShippingService: "USPS_FLAT_RATE_SMALL",
        estimatedShippingCost: 10.4,
      },
      confidence: 0.9,
      defects: [],
    })),
  };
});
vi.mock("@/lib/telemetry", () => ({
  trackEvent: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/analyze/route";
import { requireUser } from "@/lib/auth/guard";
import { checkRateLimit } from "@/lib/rate-limit";
import { spendCredits } from "@/lib/billing/credits";
import { identifyItem } from "@/lib/ai/vision";

function jpegBase64(): string {
  const bytes = Buffer.alloc(30 * 1024);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.toString("base64");
}

function analyzeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://app.example.com/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ image: jpegBase64(), mimeType: "image/jpeg" }),
  });
}

beforeEach(() => {
  vi.mocked(identifyItem).mockClear();
  vi.mocked(spendCredits).mockClear();
});

describe("/api/analyze fail-closed (regression)", () => {
  it("401s without a session — even with the old x-api-key header", async () => {
    vi.mocked(requireUser).mockResolvedValueOnce(null);
    const res = await POST(analyzeRequest({ "x-api-key": "old-beta-key" }));
    expect(res.status).toBe(401);
    expect(identifyItem).not.toHaveBeenCalled();
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it("503s retriable when the rate limiter is unavailable — Claude never called", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce("unavailable");
    const res = await POST(analyzeRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { retryable: boolean };
    expect(body.retryable).toBe(true);
    expect(identifyItem).not.toHaveBeenCalled();
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it("503s retriable when credit reservation is unavailable — Claude never called", async () => {
    vi.mocked(spendCredits).mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
    });
    const res = await POST(analyzeRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { retryable: boolean; error: string };
    expect(body.retryable).toBe(true);
    expect(body.error).toMatch(/not charged/i);
    expect(identifyItem).not.toHaveBeenCalled();
  });

  it("happy path spends exactly one credit and returns the extraction", async () => {
    const res = await POST(analyzeRequest());
    expect(res.status).toBe(200);
    expect(spendCredits).toHaveBeenCalledTimes(1);
    expect(identifyItem).toHaveBeenCalledTimes(1);
  });
});
