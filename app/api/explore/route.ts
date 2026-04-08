import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// Public endpoint — no auth required.
// Fetches only PUBLISHED listings for the Explore marketplace feed.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") ?? "";
  const category = searchParams.get("category") ?? "";

  // Build the base query — try with is_published filter first; fall back
  // without it if the column doesn't exist yet (PostgreSQL error 42703).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any[] | null = null;
  let error: { code?: string; message: string } | null = null;

  async function runQuery(includePublishedFilter: boolean) {
    let q = supabaseAdmin
      .from("listings_log")
      .select(
        "id, title, brand, model, condition, category, suggested_price, suggested_shipping_service, created_at"
      )
      .eq("status", "available")
      .order("created_at", { ascending: false })
      .limit(100);

    if (includePublishedFilter) {
      q = q.eq("is_published", true);
    }
    if (search) {
      q = q.ilike("title", `%${search}%`);
    }
    if (category) {
      q = q.ilike("category", `%${category}%`);
    }
    return q;
  }

  const primary = await runQuery(true);
  if (primary.error?.code === "42703") {
    console.warn("[explore] is_published column missing — querying without it");
    const fallback = await runQuery(false);
    data = fallback.data;
    error = fallback.error;
  } else {
    data = primary.data;
    error = primary.error;
  }

  if (error) {
    console.error("[explore] Supabase query failed", error);
    return NextResponse.json(
      { error: "Failed to load listings" },
      { status: 500 }
    );
  }

  // Extract unique top-level categories for the filter pills
  const categories = [
    ...new Set(
      (data ?? [])
        .map((l) => {
          const cat = (l.category as string) ?? "";
          return cat.includes(">") ? cat.split(">")[0].trim() : cat;
        })
        .filter(Boolean)
    ),
  ].sort();

  return NextResponse.json({ listings: data ?? [], categories });
}
