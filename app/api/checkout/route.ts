import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";

// Lazily initialised — avoids import-time crash when STRIPE_SECRET_KEY is
// absent during the build step (Next.js collects page data at build time).
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-25.dahlia",
    });
  }
  return _stripe;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let itemId: string;

  try {
    const body = (await req.json()) as { item_id?: unknown };
    if (typeof body.item_id !== "string" || !body.item_id) {
      return NextResponse.json(
        { error: "Missing item_id" },
        { status: 400 }
      );
    }
    itemId = body.item_id;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // Fetch the listing from DB — must be published
  const { data: listing, error: dbError } = await supabaseAdmin
    .from("listings_log")
    .select("id, title, suggested_price, condition, category")
    .eq("id", itemId)
    .eq("is_published", true)
    .single();

  if (dbError || !listing) {
    return NextResponse.json(
      { error: "Listing not found or not available" },
      { status: 404 }
    );
  }

  if (
    listing.suggested_price == null ||
    listing.suggested_price <= 0
  ) {
    return NextResponse.json(
      { error: "This listing has no price set" },
      { status: 400 }
    );
  }

  // Convert dollars to cents for Stripe (e.g. $10.00 → 1000)
  const priceInCents = Math.round(listing.suggested_price * 100);

  const origin = req.headers.get("origin") ?? req.nextUrl.origin;

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: listing.title,
              description: [
                listing.condition ? `Condition: ${listing.condition}` : null,
                listing.category ? `Category: ${listing.category}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/explore`,
      metadata: {
        listing_id: listing.id,
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[checkout] Stripe session creation failed", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
