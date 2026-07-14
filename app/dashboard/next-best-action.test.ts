// Unmatched-sale urgency (first-real-seller runbook): a marketplace order
// the app couldn't match to an item is a REAL sale with nothing delisted —
// the double-sale precursor. It must rank as urgent, right after oversold,
// never sit silently in a table.

import { describe, it, expect } from "vitest";
import { nextBestAction } from "./page";

function data(over: Partial<Parameters<typeof nextBestAction>[0]> = {}) {
  return {
    connections: { ebay: true, etsy: false, shopify: false },
    creditsRemaining: 10,
    creditsRenewAt: null,
    items: { draft: 2, listed: 3, sold: 1, archived: 0 },
    listedValue: 100,
    soldValue: 50,
    knownProfit: 20,
    soldWithCostCount: 1,
    soldCount: 1,
    endFailedCount: 0,
    oversoldCount: 0,
    unmatchedCount: 0,
    unmatchedEvents: [],
    ...over,
  };
}

describe("nextBestAction priority", () => {
  it("an unmatched sale is URGENT — beats failed delists and drafts", () => {
    const action = nextBestAction(data({ unmatchedCount: 1, endFailedCount: 2 }));
    expect(action.text).toMatch(/URGENT/);
    expect(action.text).toMatch(/couldn't match/);
  });

  it("oversold still outranks unmatched (a paid order already lost stock)", () => {
    const action = nextBestAction(data({ oversoldCount: 1, unmatchedCount: 1 }));
    expect(action.text).toMatch(/cancel\/refund/);
  });

  it("with nothing urgent, drafts win as before", () => {
    expect(nextBestAction(data()).text).toMatch(/draft/);
  });
});
