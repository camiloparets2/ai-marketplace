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
import { getItemDetail } from "@/lib/inventory";
import {
  freshConnection,
  getCategoryAspects,
  suggestEbayCategories,
} from "@/lib/platforms/ebay";
import {
  marketplaceById,
  DEFAULT_EBAY_MARKETPLACE,
} from "@/lib/platforms/ebay-marketplaces";
import { EBAY_CATEGORY_SPEC_KEY } from "@/lib/ebay-aspects";
import type { AspectField, CategoryOption } from "@/lib/ebay-aspects";

export interface AspectsResponse {
  connected: boolean;
  categoryId: string | null;
  categoryName: string | null;
  suggestions: CategoryOption[];
  aspects: AspectField[];
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

    const body: AspectsResponse = {
      connected: true,
      categoryId,
      categoryName:
        suggestions.find((s) => s.categoryId === categoryId)?.categoryName ??
        null,
      suggestions,
      aspects,
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
