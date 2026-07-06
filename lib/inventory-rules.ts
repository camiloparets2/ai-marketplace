// Pure decision logic for the anti-oversell sync: given an item's listings
// and where it sold, which listings must be ended? Kept free of I/O so the
// rules are unit-testable — lib/inventory.ts executes the decisions.

export interface ListingRef {
  id: string;
  platform: string; // 'ebay' | 'etsy' | 'direct'
  status: "live" | "ended" | "end_failed";
}

export interface EndPlan {
  // Listings to end via platform APIs (includes previous end failures so
  // retries happen automatically on the next sold/delist action).
  toEnd: ListingRef[];
  // Already ended — nothing to do.
  alreadyEnded: ListingRef[];
}

/**
 * Everything still live (or previously failed to end) must be ended —
 * INCLUDING the listing on the platform where the item sold, except when the
 * platform itself already ended it:
 *   - eBay/Etsy end their own listing when it sells → skip the sold platform
 *   - a Stripe payment link stays active after purchase → must be deactivated
 *     even though it's where the sale happened
 */
export function planEndListings(
  listings: ListingRef[],
  soldPlatform: string | null
): EndPlan {
  const toEnd: ListingRef[] = [];
  const alreadyEnded: ListingRef[] = [];

  for (const listing of listings) {
    if (listing.status === "ended") {
      alreadyEnded.push(listing);
      continue;
    }
    const platformEndedItItself =
      soldPlatform !== null &&
      listing.platform === soldPlatform &&
      listing.platform !== "direct";
    if (platformEndedItItself) {
      alreadyEnded.push(listing);
      continue;
    }
    toEnd.push(listing);
  }

  return { toEnd, alreadyEnded };
}
