// Title-only eBay category + item-specifics resolution — the SNAP screen's
// variant of /api/inventory/[id]/aspects:
//   GET /api/ebay/aspects?title=<listing title>[&category=<leaf id>]
//
// The snap/review screen has no draft row yet (the pipeline creates one at
// publish), so requirements resolve from the AI title through the SAME
// shared resolver the edit view and the publish chain use — the primary
// first-run path must never reach Publish with a known-missing required
// aspect. No persistence here: the chosen category rides to publish inside
// the listing's specs (__ebayCategoryId).

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import { freshConnection } from "@/lib/platforms/ebay";
import { resolveCategoryPolicyForTitle } from "@/lib/platforms/ebay-category-policies";
import {
  marketplaceById,
  DEFAULT_EBAY_MARKETPLACE,
} from "@/lib/platforms/ebay-marketplaces";
import type { AspectsResponse } from "@/app/api/inventory/[id]/aspects/route";

const DISCONNECTED: AspectsResponse = {
  connected: false,
  categoryId: null,
  categoryName: null,
  suggestions: [],
  aspects: [],
  allowedConditionIds: null,
  staleCategory: false,
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const title = req.nextUrl.searchParams.get("title")?.trim();
  if (!title) {
    return NextResponse.json({ error: "Missing title" }, { status: 400 });
  }
  const requested = req.nextUrl.searchParams.get("category")?.trim() || null;

  try {
    const stored = await getConnection(user.id, "ebay");
    if (!stored) return NextResponse.json(DISCONNECTED);
    const conn = await freshConnection(stored);
    const marketplace =
      marketplaceById(conn.meta.marketplaceId) ?? DEFAULT_EBAY_MARKETPLACE;

    const resolved = await resolveCategoryPolicyForTitle(
      conn.accessToken,
      marketplace,
      title,
      [requested]
    );
    const body: AspectsResponse = { connected: true, ...resolved };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[ebay] title aspects lookup failed:", err);
    // Advisory: the publish-time guard is the backstop.
    return NextResponse.json(
      { error: "Could not load eBay requirements. Please try again." },
      { status: 502 }
    );
  }
}
