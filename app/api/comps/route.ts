// Market comps for the pricing panel:
//   GET /api/comps?q=<title>[&brand=..][&condition=..][&category=<leaf id>]
// Returns { comps, environment, insights } — comps null means "no data,
// price conservatively" (no eBay connection, Insights not granted, lookup
// failed). `environment` lets the UI say HONESTLY that eBay's sandbox has
// no market data (Browse returns zero results there by design — eBay's own
// guidance is to test search against production), instead of implying the
// market is empty. `insights` surfaces the Marketplace Insights grant as
// observed at runtime (granted/denied/unknown) so the sold-comps access
// status is visible without log-diving.

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import {
  fetchEbayCompsFor,
  marketplaceInsightsStatus,
} from "@/lib/platforms/ebay-comps";
import { currentEbayEnvironment } from "@/lib/ebay-env";
import type { ListingInput } from "@/lib/platforms/types";
import {
  checkRateLimit,
  requestIdentity,
  RATE_RULES,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
} from "@/lib/rate-limit";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rate = await checkRateLimit(
    RATE_RULES.analyze,
    requestIdentity(req, user.id)
  );
  if (rate === "limited") {
    return NextResponse.json({ error: "Too many lookups" }, { status: 429 });
  }
  if (rate === "unavailable") {
    return NextResponse.json(
      { error: RATE_LIMIT_UNAVAILABLE_MESSAGE },
      { status: 503 }
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing q" }, { status: 400 });
  }

  // Optional structured hints — anything unrecognized is simply dropped.
  const brand = req.nextUrl.searchParams.get("brand")?.trim() || null;
  const categoryId =
    req.nextUrl.searchParams.get("category")?.trim() || null;
  const rawCondition = req.nextUrl.searchParams.get("condition")?.trim();
  const CONDITIONS: ReadonlyArray<ListingInput["condition"]> = [
    "New",
    "Like New",
    "Very Good",
    "Good",
    "Acceptable",
  ];
  const condition =
    CONDITIONS.find((c) => c === rawCondition) ?? null;

  const environment = currentEbayEnvironment();
  try {
    const conn = await getConnection(user.id, "ebay");
    if (!conn) {
      return NextResponse.json({
        comps: null,
        environment,
        insights: marketplaceInsightsStatus(),
      });
    }
    const comps = await fetchEbayCompsFor({
      accessToken: conn.accessToken,
      brand,
      categoryId,
      titleKeywords: q,
      condition,
    });
    return NextResponse.json({
      comps,
      environment,
      insights: marketplaceInsightsStatus(),
    });
  } catch {
    // Comps are advisory — never fail the caller over them.
    return NextResponse.json({
      comps: null,
      environment,
      insights: marketplaceInsightsStatus(),
    });
  }
}
