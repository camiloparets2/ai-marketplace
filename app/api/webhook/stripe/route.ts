import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";

// Lazily initialised — avoids import-time crash when STRIPE_SECRET_KEY is
// absent during the build step.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-25.dahlia",
    });
  }
  return _stripe;
}

// ─── Stripe webhook handler ─────────────────────────────────────────────────
// Listens for checkout.session.completed → marks the purchased item as "sold"
// and removes it from the public Explore feed.
//
// IMPORTANT: Stripe sends the raw body as-is for signature verification.
// Next.js App Router provides the raw body via request.text(), NOT request.json().

export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook/stripe] STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 500 }
    );
  }

  // ── Verify signature ────────────────────────────────────────────────────────
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;
  try {
    const rawBody = await req.text();
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[webhook/stripe] Signature verification failed:", message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  // ── Handle account.updated (Connect onboarding completed) ───────────────────
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const chargesEnabled = account.charges_enabled ?? false;

    const { error } = await supabaseAdmin
      .from("seller_profiles")
      .update({ charges_enabled: chargesEnabled })
      .eq("stripe_account_id", account.id);

    if (error) {
      console.error(
        "[webhook/stripe] Failed to update charges_enabled for",
        account.id,
        error
      );
    } else {
      console.log(
        "[webhook/stripe] Updated charges_enabled for",
        account.id,
        "→",
        chargesEnabled
      );
    }
  }

  // ── Handle checkout.session.completed ───────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const listingId = session.metadata?.listing_id;

    if (!listingId) {
      console.warn(
        "[webhook/stripe] checkout.session.completed missing listing_id in metadata",
        session.id
      );
      // Return 200 so Stripe doesn't retry — nothing we can do without the ID.
      return NextResponse.json({ received: true });
    }

    // Idempotency: check if already sold before updating.
    // Stripe may deliver the same event more than once.
    const { data: existing } = await supabaseAdmin
      .from("listings_log")
      .select("status")
      .eq("id", listingId)
      .single();

    if (existing?.status === "sold") {
      console.log("[webhook/stripe] Listing already sold (duplicate event):", listingId);
      return NextResponse.json({ received: true });
    }

    // Mark as sold + unpublish in a single update.
    const { error } = await supabaseAdmin
      .from("listings_log")
      .update({ status: "sold", is_published: false })
      .eq("id", listingId);

    if (error) {
      console.error(
        "[webhook/stripe] Failed to mark listing as sold:",
        listingId,
        error
      );
      // Return 500 so Stripe retries the webhook.
      return NextResponse.json(
        { error: "Database update failed" },
        { status: 500 }
      );
    }

    console.log("[webhook/stripe] Listing marked as sold:", listingId);
  }

  // Acknowledge all events (even ones we don't handle) with 200.
  return NextResponse.json({ received: true });
}
