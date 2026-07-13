// Draft-time eBay category + item-specifics resolution:
//   GET /api/inventory/[id]/aspects[?category=<leaf id>]
//
// The seller learns what eBay requires BEFORE hitting publish (the publish
// guard stays as the backstop). Resolution goes through the ONE shared
// resolver (lib/platforms/ebay-category-policies), and the winner is PINNED
// on the draft (__ebayCategoryId in specs) so the breadcrumb, the form, and
// the publish step always agree. `?category=` previews a different
// candidate. The snap screen's title-only variant is /api/ebay/aspects.
//
// No eBay connection is fine — the form simply doesn't render and publish
// gating is left to the server-side guard.

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import { getItemDetail, mergeItemSpecs } from "@/lib/inventory";
import { freshConnection } from "@/lib/platforms/ebay";
import { resolveCategoryPolicyForTitle } from "@/lib/platforms/ebay-category-policies";
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

const DISCONNECTED: AspectsResponse = {
  connected: false,
  categoryId: null,
  categoryName: null,
  suggestions: [],
  aspects: [],
  allowedConditionIds: null,
  staleCategory: false,
};

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
    if (!stored) return NextResponse.json(DISCONNECTED);
    const conn = await freshConnection(stored);
    const marketplace =
      marketplaceById(conn.meta.marketplaceId) ?? DEFAULT_EBAY_MARKETPLACE;

    // Preference order: explicit preview (?category=) → the draft's saved
    // choice → eBay's suggestions. First CURRENT LEAF wins.
    const requested = req.nextUrl.searchParams.get("category")?.trim() || null;
    const saved = item.specs?.[EBAY_CATEGORY_SPEC_KEY]?.trim() || null;
    const resolved = await resolveCategoryPolicyForTitle(
      conn.accessToken,
      marketplace,
      item.title,
      [requested, saved]
    );

    // ONE resolver, ONE answer: pin this resolution on the draft so the
    // breadcrumb, the form, and the publish step (which honors the saved
    // __ebayCategoryId, never re-suggesting from the title) all agree.
    // Editable items only; a failure here degrades to unpinned, not a 5xx.
    if (
      resolved.categoryId !== null &&
      resolved.categoryId !== saved &&
      (item.status === "draft" || item.status === "review")
    ) {
      await mergeItemSpecs(user.id, id, {
        [EBAY_CATEGORY_SPEC_KEY]: resolved.categoryId,
        ...(resolved.categoryName
          ? { [EBAY_CATEGORY_NAME_SPEC_KEY]: resolved.categoryName }
          : {}),
      }).catch((err) => {
        console.warn(`[inventory] category pin failed for ${id}:`, err);
        return false;
      });
    }

    const body: AspectsResponse = { connected: true, ...resolved };
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
