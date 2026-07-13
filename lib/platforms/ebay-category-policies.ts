// THE category-policy layer (one read surface, one answer): everything a
// leaf category dictates about a listing, fetched from eBay's metadata and
// cached — never hardcoded. Three sandbox bugs in one test run came from
// treating category metadata as constants:
//   1. required item aspects        → getCategoryAspects (Taxonomy)
//   2. shipping services            → marketplace-level, ebay-marketplaces.ts
//   3. legal item conditions        → getAllowedConditionIds (Sell Metadata)
// Routes and the UI read categories through THIS module; the publish chain
// in ebay.ts uses the same underlying fetchers (and their caches), so the
// draft-time form and the publish payload can never disagree.

import {
  getCategoryAspects,
  getAllowedConditionIds,
} from "@/lib/platforms/ebay";
import type { EbayMarketplace } from "@/lib/platforms/ebay-marketplaces";
import type { AspectField } from "@/lib/ebay-aspects";

export interface CategoryPolicy {
  // null → unknown (lookup failed / non-leaf) — callers degrade, never block
  // on missing metadata; the publish-time guards are the backstop.
  aspects: AspectField[] | null;
  allowedConditionIds: string[] | null;
}

export async function getCategoryPolicy(
  accessToken: string,
  marketplace: EbayMarketplace,
  categoryId: string
): Promise<CategoryPolicy> {
  const [aspects, allowedConditionIds] = await Promise.all([
    getCategoryAspects(accessToken, marketplace.categoryTreeId, categoryId),
    getAllowedConditionIds(accessToken, marketplace.id, categoryId),
  ]);
  return { aspects, allowedConditionIds };
}
