// Regression: publishing costs ZERO credits — always.
//
// Production bug (fix/draft-publish-and-credits): failed publishes left
// orphaned drafts, and the only way to try again was to re-snap the photo —
// burning another AI credit for an item that was already extracted. The fix
// is the draft publish/retry path, which must republish from the STORED row.
//
// This test pins the two credit invariants:
//   1. The billing module's spend/refund functions are never touched by any
//      publish path — draft republish, review approval, or the /api/publish
//      fan-out. Credits are spent at /api/analyze (extraction) ONLY.
//   2. publishDraft never re-runs AI identification, so there is nothing a
//      publish retry could even be charged for.

import { describe, it, expect, vi } from "vitest";

// Spy on the billing module BEFORE any module under test can import it.
vi.mock("@/lib/billing/credits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/credits")>();
  return {
    ...actual,
    spendCredits: vi.fn(actual.spendCredits),
    refundCredits: vi.fn(actual.refundCredits),
  };
});

import { spendCredits, refundCredits } from "@/lib/billing/credits";
import { publishDraft, approveAndPublish } from "@/lib/pipeline";
import type { PipelineDeps } from "@/lib/pipeline";

const item = {
  id: "item-1",
  title: "SAKRETE 50 lb Concrete Mix",
  brand: "SAKRETE",
  model: null,
  upc: null,
  condition: "New",
  category: "Home & Garden > Building Materials",
  specs: {},
  photo_url: "https://cdn.example/concrete.jpg",
  price: 12.99,
  cost_of_goods: 3.5,
  shipping_cost: 18.4,
  status: "draft" as const,
  review_reasons: [],
};

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    identify: vi.fn().mockRejectedValue(new Error("AI must never run here")),
    hostPhoto: vi.fn().mockResolvedValue("https://cdn.example/p.jpg"),
    createDraft: vi.fn().mockResolvedValue("item-1"),
    price: vi.fn(),
    fetchComps: vi.fn().mockResolvedValue(null),
    recordPrice: vi.fn().mockResolvedValue(undefined),
    setPrice: vi.fn().mockResolvedValue(undefined),
    setReview: vi.fn().mockResolvedValue(undefined),
    guardrails: vi.fn(),
    audit: vi.fn().mockResolvedValue(undefined),
    getEbayConnection: vi.fn().mockResolvedValue({
      userId: "user-1",
      platform: "ebay",
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3_600_000,
      meta: {},
    }),
    publishEbay: vi.fn().mockResolvedValue({
      url: "https://sandbox.ebay.com/itm/1",
      listingId: "1",
      offerId: "off-1",
      sku: "snap-1",
    }),
    getEtsyConnection: vi.fn().mockResolvedValue(null),
    publishEtsy: vi.fn(),
    route: vi.fn(),
    getItem: vi.fn().mockResolvedValue(item),
    approveReview: vi.fn().mockResolvedValue(true),
    recordListing: vi.fn().mockResolvedValue(undefined),
    markListed: vi.fn().mockResolvedValue(undefined),
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    beginAttempt: vi.fn().mockResolvedValue("attempt-1"),
    completeAttempt: vi.fn().mockResolvedValue(true),
    publishMode: () => "sandbox" as const,
    ...over,
  };
}

describe("republishing costs zero credits (regression)", () => {
  it("publishDraft spends nothing and never calls AI — success or failure", async () => {
    const good = deps();
    const ok = await publishDraft("user-1", "item-1", good);
    expect(ok.ok).toBe(true);

    const bad = deps({
      publishEbay: vi.fn().mockRejectedValue(new Error("eBay 500")),
    });
    const failed = await publishDraft("user-1", "item-1", bad);
    expect(failed.ok).toBe(true); // handled: outcome carries the error
    if (failed.ok) expect(failed.publish.status).toBe("error");

    expect(good.identify).not.toHaveBeenCalled();
    expect(bad.identify).not.toHaveBeenCalled();
    expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(refundCredits)).not.toHaveBeenCalled();
  });

  it("review approval publishes without touching credits either", async () => {
    const d = deps({
      getItem: vi.fn().mockResolvedValue({ ...item, status: "review" }),
    });
    const result = await approveAndPublish("user-1", "item-1", null, d);
    expect(result.ok).toBe(true);
    expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(refundCredits)).not.toHaveBeenCalled();
  });
});
