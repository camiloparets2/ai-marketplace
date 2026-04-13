import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// ─── GET: Fetch a single published listing by ID ─────────────────────────────
// Public route — no auth required. Only returns available, published listings.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing listing ID" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("listings_log")
    .select(
      "id, title, brand, model, upc, condition, category, suggested_price, suggested_shipping_service, stock_image_url, original_image_urls, raw_specs, price_rationale, created_at"
    )
    .eq("id", id)
    .eq("status", "available")
    .eq("is_published", true)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Listing not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ listing: data });
}
