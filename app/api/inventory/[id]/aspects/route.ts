// Draft-time eBay category + item-specifics resolution:
//   GET /api/inventory/[id]/aspects[?category=<leaf id>]
//
// The seller learns what eBay requires BEFORE hitting publish (the publish
// guard stays as the backstop). Returns the resolved leaf category, the
// seller-facing category candidates, and the full aspect metadata the
// draft-edit form renders (required vs recommended, closed enums vs free
// text). `?category=` previews a different candidate without saving it.
//
// No eBay connection is fine — the form simply doesn't render and publish
// gating is left to the server-side guard.

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import { getItemDetail, mergeItemSpecs } from "@/lib/inventory";
import {
  freshConnection,
  getCategoryAspects,
  suggestEbayCategories,
} from "@/lib/platforms/ebay";
import { getCategoryPolicy } from "@/lib/platforms/ebay-category-policies";
import {
  marketplaceById,
  DEFAULT_EBAY_MARKETPLACE,
} from "@/lib/platforms/ebay-marketplaces";
import {
  EBAY_CATEGORY_SPEC_KEY,
  EBAY_CATEGORY_NAME_SPEC_KEY,
} from "@/lib/ebay-aspects";
import type { AspectField, CategoryOption } from "@/lib/ebay-aspects";

export interface AspectsResponse {
  connected: boolean;
  categoryId: string | null;
  categoryName: string | null;
  suggestions: CategoryOption[];
  aspects: AspectField[];
  // Condition ids this category legally accepts (Sell Metadata) — the
  // condition dropdown constrains itself to grades that map to one of
  // these. null → policy unknown; the UI must NOT constrain on it.
  allowedConditionIds: string[] | null;
  // True when the stored/requested category id was no longer a valid leaf
  // and the response fell back to a suggestion — the UI says so.
  staleCategory: boolean;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const item = await getItemDetail(user.id, id);
    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    const stored = await getConnection(user.id, "ebay");
    if (!stored) {
      const body: AspectsResponse = {
        connected: false,
        categoryId: null,
        categoryName: null,
        suggestions: [],
        aspects: [],
        allowedConditionIds: null,
        staleCategory: false,
      };
      return NextResponse.json(body);
    }
    const conn = await freshConnection(stored);
    const marketplace =
      marketplaceById(conn.meta.marketplaceId) ?? DEFAULT_EBAY_MARKETPLACE;
    const treeId = marketplace.categoryTreeId;

    const suggestions = await suggestEbayCategories(
      conn.accessToken,
      item.title,
      treeId
    ).catch(() => [] as CategoryOption[]);

    // Preference order: explicit preview (?category=) → the draft's saved
    // choice → eBay's suggestions. First CURRENT LEAF wins; a stale saved id
    // is reported, never silently trusted.
    const requested = req.nextUrl.searchParams.get("category")?.trim() || null;
    const saved = item.specs?.[EBAY_CATEGORY_SPEC_KEY]?.trim() || null;
    const candidates: string[] = [];
    for (const idCandidate of [
      requested,
      saved,
      ...suggestions.map((s) => s.categoryId),
    ]) {
      if (idCandidate && !candidates.includes(idCandidate)) {
        candidates.push(idCandidate);
      }
    }

    let categoryId: string | null = null;
    let aspects: AspectField[] = [];
    let staleCategory = false;
    for (const candidate of candidates) {
      const fields = await getCategoryAspects(conn.accessToken, treeId, candidate);
      if (fields === null) {
        // The seller's explicit pick (or saved pick) is no longer a leaf.
        if (candidate === requested || candidate === saved) staleCategory = true;
        continue;
      }
      categoryId = candidate;
      aspects = fields;
      break;
    }

    const categoryName =
      suggestions.find((s) => s.categoryId === categoryId)?.categoryName ??
      null;

    // Full policy for the resolved category through the ONE category-policy
    // layer (same fetchers/caches the publish step uses), so the dropdown
    // only offers grades the category legally accepts. The aspects fetch is
    // a cache hit — the loop above already resolved this category.
    const allowedConditionIds =
      categoryId !== null
        ? (await getCategoryPolicy(conn.accessToken, marketplace, categoryId))
            .allowedConditionIds
        : null;

    // ONE resolver, ONE answer: pin this resolution on the draft so the
    // breadcrumb, the form, and the publish step (which honors the saved
    // __ebayCategoryId, never re-suggesting from the title) all agree.
    // Editable items only; a failure here degrades to unpinned, not a 5xx.
    if (
      categoryId !== null &&
      categoryId !== saved &&
      (item.status === "draft" || item.status === "review")
    ) {
      await mergeItemSpecs(user.id, id, {
        [EBAY_CATEGORY_SPEC_KEY]: categoryId,
        ...(categoryName ? { [EBAY_CATEGORY_NAME_SPEC_KEY]: categoryName } : {}),
      }).catch((err) => {
        console.warn(`[inventory] category pin failed for ${id}:`, err);
        return false;
      });
    }

    const body: AspectsResponse = {
      connected: true,
      categoryId,
      categoryName,
      suggestions,
      aspects,
      allowedConditionIds,
      staleCategory,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`[inventory] aspects lookup failed for ${id}:`, err);
    // Advisory endpoint: the publish-time guard is the backstop, so a lookup
    // failure degrades to "no data" instead of breaking the edit view.
    return NextResponse.json(
      { error: "Could not load eBay requirements. Please try again." },
      { status: 502 }
    );
  }
}
