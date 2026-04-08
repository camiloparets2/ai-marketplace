import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getConnectLimiter,
  isRateLimitConfigured,
} from "@/lib/rate-limit";

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-25.dahlia",
    });
  }
  return _stripe;
}

// ─── POST: Generate a Stripe Connect onboarding link ────────────────────────
// If the seller doesn't have a Connect account yet, one is created (Express).
// Returns { url } pointing to Stripe's hosted onboarding flow.

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ─────────────────────────────────────────────────────────────────────
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

  // ── Rate limiting — per user, 5 req/hour ──────────────────────────────────
  if (isRateLimitConfigured()) {
    try {
      const { success } = await getConnectLimiter().limit(user.id);
      if (!success) {
        return NextResponse.json(
          { error: "Too many onboarding attempts. Please try again later." },
          { status: 429 }
        );
      }
    } catch (rlErr) {
      console.error("[connect] Rate limiter error — failing open", rlErr);
    }
  }

  // ── Check for existing Connect account ──────────────────────────────────────
  const { data: profile } = await supabaseAdmin
    .from("seller_profiles")
    .select("stripe_account_id, charges_enabled")
    .eq("id", user.id)
    .single();

  let stripeAccountId = profile?.stripe_account_id ?? null;

  // ── Create Express account if needed ────────────────────────────────────────
  if (!stripeAccountId) {
    try {
      const account = await getStripe().accounts.create({
        type: "express",
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      stripeAccountId = account.id;

      // Upsert into seller_profiles
      const { error: upsertError } = await supabaseAdmin
        .from("seller_profiles")
        .upsert(
          { id: user.id, stripe_account_id: account.id, charges_enabled: false },
          { onConflict: "id" }
        );

      if (upsertError) {
        console.error("[connect] Failed to save stripe_account_id", upsertError);
        return NextResponse.json(
          { error: "Failed to save account. Please try again." },
          { status: 500 }
        );
      }
    } catch (err) {
      console.error("[connect] Stripe account creation failed", err);
      return NextResponse.json(
        { error: "Failed to create payment account. Please try again." },
        { status: 500 }
      );
    }
  }

  // ── Generate onboarding link ────────────────────────────────────────────────
  const origin = req.headers.get("origin") ?? req.nextUrl.origin;

  try {
    const accountLink = await getStripe().accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${origin}/dashboard?connect=refresh`,
      return_url: `${origin}/dashboard?connect=complete`,
      type: "account_onboarding",
    });

    return NextResponse.json({ url: accountLink.url });
  } catch (err) {
    console.error("[connect] Account link creation failed", err);
    return NextResponse.json(
      { error: "Failed to generate onboarding link. Please try again." },
      { status: 500 }
    );
  }
}

// ─── GET: Return the seller's Connect status ────────────────────────────────
// Used by the Dashboard to show the correct badge / button.

export async function GET(req: NextRequest): Promise<NextResponse> {
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

  const { data: profile } = await supabaseAdmin
    .from("seller_profiles")
    .select("stripe_account_id, charges_enabled")
    .eq("id", user.id)
    .single();

  if (!profile?.stripe_account_id) {
    return NextResponse.json({ connected: false, charges_enabled: false });
  }

  // Refresh charges_enabled from Stripe in case it changed since last check.
  try {
    const account = await getStripe().accounts.retrieve(
      profile.stripe_account_id
    );
    const chargesEnabled = account.charges_enabled ?? false;

    // Update DB if it changed.
    if (chargesEnabled !== profile.charges_enabled) {
      await supabaseAdmin
        .from("seller_profiles")
        .update({ charges_enabled: chargesEnabled })
        .eq("id", user.id);
    }

    return NextResponse.json({
      connected: true,
      charges_enabled: chargesEnabled,
    });
  } catch (err) {
    console.error("[connect] Failed to retrieve Stripe account", err);
    // Return stale data rather than failing.
    return NextResponse.json({
      connected: !!profile.stripe_account_id,
      charges_enabled: profile.charges_enabled,
    });
  }
}
