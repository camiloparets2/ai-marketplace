// Market comps for the pricing panel: GET /api/comps?q=<title>
// Returns { comps: CompsSummary | null } — null means "no data, price
// conservatively" (no eBay connection, Insights not granted, lookup failed).
// Same graceful-degrade contract as the pipeline's pricing step.

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import { fetchEbayComps } from "@/lib/comps";
import { checkRateLimit, requestIdentity, RATE_RULES } from "@/lib/rate-limit";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await checkRateLimit(
    RATE_RULES.analyze,
    requestIdentity(req, user.id)
  );
  if (!allowed) {
    return NextResponse.json({ error: "Too many lookups" }, { status: 429 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing q" }, { status: 400 });
  }

  try {
    const conn = await getConnection(user.id, "ebay");
    if (!conn) return NextResponse.json({ comps: null });
    const comps = await fetchEbayComps(conn.accessToken, q);
    return NextResponse.json({ comps });
  } catch {
    // Comps are advisory — never fail the caller over them.
    return NextResponse.json({ comps: null });
  }
}
