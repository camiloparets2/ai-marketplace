// Manual sale price capture (sandbox finding: sold_price / sale_price were
// always NULL — profit tracking and gross revenue were impossible). The
// "sold" action REQUIRES the real amount: never silently null, never
// silently the asking price (buyers haggle), $0 only when typed on purpose.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/inventory", () => ({
  delistItem: vi.fn(),
  archiveItem: vi.fn(),
  setItemCost: vi.fn(),
  rejectItemFromReview: vi.fn(),
}));
vi.mock("@/lib/pipeline", () => ({
  approveAndPublish: vi.fn(),
  publishDraft: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/telemetry", () => ({ trackEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/sold-events", () => ({
  handleManualSale: vi.fn(async () => ({ ok: true, endResults: [] })),
}));

import { POST } from "./route";
import { handleManualSale } from "@/lib/sold-events";

function soldRequest(body: Record<string, unknown>): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest("https://app.example.com/api/inventory/item-1/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "item-1" }) },
  ];
}

beforeEach(() => {
  vi.mocked(handleManualSale).mockClear();
});

describe("POST actions — sold price is required and respected", () => {
  it.each([
    ["missing", { action: "sold", platform: "offerup" }],
    ["a string", { action: "sold", platform: "offerup", soldPrice: "8" }],
    ["negative", { action: "sold", platform: "offerup", soldPrice: -1 }],
  ])("rejects a sale with %s soldPrice — nothing is recorded", async (_label, body) => {
    const res = await POST(...soldRequest(body));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/soldPrice/);
    expect(handleManualSale).not.toHaveBeenCalled();
  });

  it("passes the HAGGLED price through, not the asking price", async () => {
    // Asking was $8.00; the buyer talked it down to $6.50.
    const res = await POST(
      ...soldRequest({ action: "sold", platform: "offerup", soldPrice: 6.5 })
    );
    expect(res.status).toBe(200);
    expect(handleManualSale).toHaveBeenCalledWith("user-1", "item-1", "offerup", 6.5);
  });

  it("accepts an explicit $0 (deliberate giveaway), typed on purpose", async () => {
    const res = await POST(
      ...soldRequest({ action: "sold", platform: "other", soldPrice: 0 })
    );
    expect(res.status).toBe(200);
    expect(handleManualSale).toHaveBeenCalledWith("user-1", "item-1", "other", 0);
  });
});
