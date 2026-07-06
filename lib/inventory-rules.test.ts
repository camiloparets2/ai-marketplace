import { describe, it, expect } from "vitest";
import { planEndListings } from "./inventory-rules";
import type { ListingRef } from "./inventory-rules";

const live = (id: string, platform: string): ListingRef => ({
  id,
  platform,
  status: "live",
});

describe("planEndListings", () => {
  it("ends every other channel when an item sells on eBay", () => {
    const plan = planEndListings(
      [live("a", "ebay"), live("b", "etsy"), live("c", "direct")],
      "ebay"
    );
    expect(plan.toEnd.map((l) => l.id)).toEqual(["b", "c"]);
    // eBay ended its own listing at sale time
    expect(plan.alreadyEnded.map((l) => l.id)).toEqual(["a"]);
  });

  it("deactivates the payment link even when the sale happened there", () => {
    // Stripe payment links stay active after purchase — leaving it live
    // would let a second buyer pay for a sold item.
    const plan = planEndListings(
      [live("a", "ebay"), live("c", "direct")],
      "direct"
    );
    expect(plan.toEnd.map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("ends everything on a plain delist (no sale)", () => {
    const plan = planEndListings(
      [live("a", "ebay"), live("b", "etsy"), live("c", "direct")],
      null
    );
    expect(plan.toEnd).toHaveLength(3);
    expect(plan.alreadyEnded).toHaveLength(0);
  });

  it("retries previous end failures and skips already-ended listings", () => {
    const plan = planEndListings(
      [
        { id: "a", platform: "etsy", status: "end_failed" },
        { id: "b", platform: "ebay", status: "ended" },
      ],
      null
    );
    expect(plan.toEnd.map((l) => l.id)).toEqual(["a"]);
    expect(plan.alreadyEnded.map((l) => l.id)).toEqual(["b"]);
  });
});
