import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";
import { postListingToEbay, type EbayListingInput } from "@/lib/ebay";

// ─── POST /api/ebay/post ──────────────────────────────────────────────────────
// Publishes a listing to eBay via the 3-step Inventory API flow.
// Body: { listing_id: string }
// Returns: { ebayUrl: string }

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth gate
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: () => {},
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as { listing_id?: string } | null;
  const listing_id = body?.listing_id;

  if (!listing_id) {
    return NextResponse.json({ error: "listing_id is required" }, { status: 400 });
  }

  // Fetch listing — must belong to this seller and be published
  const { data: listing, error: dbError } = await supabaseAdmin
    .from("listings")
    .select(
      "id, title, brand, description, condition, suggested_price, stock_image_url, category"
    )
    .eq("id", listing_id)
    .eq("user_id", user.id)
    .eq("is_published", true)
    .single();

  if (dbError || !listing) {
    return NextResponse.json(
      { error: "Listing not found or not yet published. Publish it first." },
      { status: 404 }
    );
  }

  if (!listing.suggested_price) {
    return NextResponse.json(
      { error: "Listing has no price set. Please set a price before posting to eBay." },
      { status: 400 }
    );
  }

  const input: EbayListingInput = {
    listingId: listing.id as string,
    title: listing.title as string,
    brand: listing.brand as string | null,
    description: (listing.description as string | null) ?? (listing.title as string),
    condition: listing.condition as string,
    price: listing.suggested_price as number,
    stockImageUrl: listing.stock_image_url as string | null,
    category: listing.category as string,
  };

  try {
    const ebayUrl = await postListingToEbay(user.id, input);
    console.log("[ebay/post] Successfully posted listing", listing_id, "→", ebayUrl);
    return NextResponse.json({ ebayUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to post to eBay.";
    console.error("[ebay/post] Error for listing", listing_id, ":", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
