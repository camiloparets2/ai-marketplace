import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// Public endpoint — no auth required.
// Fetches only PUBLISHED listings for the Explore marketplace feed.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") ?? "";
  const category = searchParams.get("category") ?? "";

  let query = supabaseAdmin
    .from("listings_log")
    .select(
      "id, title, brand, model, condition, category, suggested_price, suggested_shipping_service, created_at"
    )
    .eq("is_published", true)
    .order("created_at", { ascending: false })
    .limit(100);

  if (search) {
    query = query.ilike("title", `%${search}%`);
  }

  if (category) {
    query = query.ilike("category", `%${category}%`);
  }

  const { data, error } = await query;

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
