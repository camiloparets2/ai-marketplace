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
  suggestEbayCategories,
} from "@/lib/platforms/ebay";
import type { EbayMarketplace } from "@/lib/platforms/ebay-marketplaces";
import type { AspectField, CategoryOption } from "@/lib/ebay-aspects";

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

// ── Title → leaf category + full policy (the ONE resolver) ─────────────────
//
// Shared by the snap/review screen (no draft row yet — title only) and the
// /inventory/[id] edit view (which also passes its saved category as a
// preferred candidate and pins the winner on the draft). One resolver means
// the two screens and the publish step can never disagree on the category.

export interface ResolvedCategoryPolicy {
  categoryId: string | null;
  categoryName: string | null;
  suggestions: CategoryOption[];
  aspects: AspectField[];
  allowedConditionIds: string[] | null;
  // True when a PREFERRED candidate (saved/requested id) was no longer a
  // valid leaf and the resolution fell back to a suggestion.
  staleCategory: boolean;
}

export async function resolveCategoryPolicyForTitle(
  accessToken: string,
  marketplace: EbayMarketplace,
  title: string,
  // Highest-preference first (e.g. [requested, saved]); nulls skipped.
  preferredCategoryIds: Array<string | null> = []
): Promise<ResolvedCategoryPolicy> {
  const treeId = marketplace.categoryTreeId;
  const suggestions = await suggestEbayCategories(
    accessToken,
    title,
    treeId
  ).catch(() => [] as CategoryOption[]);

  const preferred = preferredCategoryIds.filter(
    (id): id is string => Boolean(id?.trim())
  );
  const candidates: string[] = [];
  for (const id of [...preferred, ...suggestions.map((s) => s.categoryId)]) {
    if (!candidates.includes(id)) candidates.push(id);
  }

  let categoryId: string | null = null;
  let aspects: AspectField[] = [];
  let staleCategory = false;
  for (const candidate of candidates) {
    const fields = await getCategoryAspects(accessToken, treeId, candidate);
    if (fields === null) {
      // A stale preferred pick is reported, never silently trusted.
      if (preferred.includes(candidate)) staleCategory = true;
      continue;
    }
    categoryId = candidate;
    aspects = fields;
    break;
  }

  const allowedConditionIds =
    categoryId !== null
      ? await getAllowedConditionIds(accessToken, marketplace.id, categoryId)
      : null;

  return {
    categoryId,
    categoryName:
      suggestions.find((s) => s.categoryId === categoryId)?.categoryName ??
      null,
    suggestions,
    aspects,
    allowedConditionIds,
    staleCategory,
  };
}
