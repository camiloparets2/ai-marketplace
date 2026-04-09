import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getCheckoutLimiter,
  isRateLimitConfigured,
  getClientIp,
} from "@/lib/rate-limit";

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

  // ── Rate limiting — per IP, 10 req/min ─────────────────────────────────────
  if (isRateLimitConfigured()) {
    try {
      const ip = getClientIp(req);
      const { success } = await getCheckoutLimiter().limit(ip);
      if (!success) {
        return NextResponse.json(
          { error: "Too many checkout attempts. Please wait a moment." },
          { status: 429 }
        );
      }
    } catch (rlErr) {
      console.error("[checkout] Rate limiter error — failing open", rlErr);
    }
  }

  // Fetch the listing from DB — must be published and available.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listing: any = null;
  let dbError: { code?: string; message: string } | null = null;

  const primary = await supabaseAdmin
    .from("listings_log")
    .select("id, title, suggested_price, condition, category, seller_id")
    .eq("id", itemId)
    .eq("is_published", true)
    .eq("status", "available")
    .single();

  if (primary.error?.code === "42703") {
    console.warn("[checkout] is_published/status column missing — querying without it");
    const fallback = await supabaseAdmin
      .from("listings_log")
      .select("id, title, suggested_price, condition, category, seller_id")
      .eq("id", itemId)
      .single();
    listing = fallback.data;
    dbError = fallback.error;
  } else {
    listing = primary.data;
    dbError = primary.error;
  }

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

  // ── Look up seller's Stripe Connect account ────────────────────────────────
  let sellerStripeAccountId: string | null = null;

  if (listing.seller_id) {
    const { data: sellerProfile } = await supabaseAdmin
      .from("seller_profiles")
      .select("stripe_account_id, charges_enabled")
      .eq("id", listing.seller_id)
      .single();

    if (sellerProfile?.charges_enabled && sellerProfile.stripe_account_id) {
      sellerStripeAccountId = sellerProfile.stripe_account_id;
    }
  }

  if (!sellerStripeAccountId) {
    return NextResponse.json(
      { error: "This seller hasn't set up payouts yet. Please try again later." },
      { status: 400 }
    );
  }

  // Convert dollars to cents for Stripe (e.g. $10.00 → 1000)
  const priceInCents = Math.round(listing.suggested_price * 100);
  // Platform takes 10% fee
  const applicationFee = Math.round(priceInCents * 0.1);

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
      payment_intent_data: {
        application_fee_amount: applicationFee,
        transfer_data: {
          destination: sellerStripeAccountId,
        },
      },
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
