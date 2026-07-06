// Stripe Billing integration — customers, checkout, portal, and the pieces
// the webhook needs to sync subscription state.
//
// Zero-dashboard setup: products/prices are created on demand and found again
// via Stripe price lookup_keys (lookup_key = plan key), so the only manual
// Stripe steps are the two env secrets and the webhook endpoint.

import Stripe from "stripe";
import { getSupabaseAdmin } from "@/lib/connections";
import { PLANS, isPaidPlanKey } from "@/lib/billing/plans";
import type { PlanKey } from "@/lib/billing/plans";

let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// ─── Customer mapping ─────────────────────────────────────────────────────────

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null
): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle<{ stripe_customer_id: string }>();
  if (error) throw new Error(`customer lookup failed: ${error.message}`);
  if (data) return data.stripe_customer_id;

  const customer = await getStripe().customers.create({
    ...(email ? { email } : {}),
    metadata: { user_id: userId },
  });

  const { error: insertError } = await supabase
    .from("billing_customers")
    .insert({ user_id: userId, stripe_customer_id: customer.id });
  if (insertError && insertError.code !== "23505") {
    throw new Error(`customer save failed: ${insertError.message}`);
  }
  // Lost the race → another request created the mapping; use theirs.
  if (insertError?.code === "23505") {
    const { data: winner } = await supabase
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .single<{ stripe_customer_id: string }>();
    if (winner) return winner.stripe_customer_id;
  }
  return customer.id;
}

export async function userIdForCustomer(
  stripeCustomerId: string
): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle<{ user_id: string }>();
  return data?.user_id ?? null;
}

// ─── Price resolution via lookup keys ─────────────────────────────────────────

async function resolvePriceId(planKey: PlanKey): Promise<string> {
  const stripe = getStripe();
  const plan = PLANS[planKey];
  const unitAmount = Math.round(plan.priceUsd * 100);

  // The catalog (lib/billing/plans.ts) is the source of truth. If a Stripe
  // price exists under this lookup key AND still matches the catalog amount,
  // reuse it; if the catalog changed, mint a new price and transfer the
  // lookup key so new checkouts get the new price (existing subscribers
  // keep the price they signed up at).
  const existing = await stripe.prices.list({
    lookup_keys: [planKey],
    active: true,
    limit: 1,
  });
  const current = existing.data[0];
  if (current && current.unit_amount === unitAmount) return current.id;

  const productId =
    current !== undefined
      ? typeof current.product === "string"
        ? current.product
        : current.product.id
      : (
          await stripe.products.create({
            name: `Snap to List — ${plan.name}`,
            metadata: { plan_key: planKey },
          })
        ).id;

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: planKey,
    // Moves the lookup key off the outdated price onto this one.
    transfer_lookup_key: true,
  });
  return price.id;
}

// ─── Checkout + portal sessions ───────────────────────────────────────────────

export async function createSubscriptionCheckout(
  userId: string,
  email: string | null,
  planKey: string,
  appUrl: string
): Promise<string> {
  if (!isPaidPlanKey(planKey)) {
    throw new Error(`Unknown plan: ${planKey}`);
  }
  const customer = await getOrCreateStripeCustomer(userId, email);
  const price = await resolvePriceId(planKey);

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    // Copied onto the Subscription object → every webhook event about this
    // subscription carries the user and plan without extra lookups.
    subscription_data: { metadata: { user_id: userId, plan_key: planKey } },
    allow_promotion_codes: true,
    success_url: `${appUrl}/billing?checkout=success`,
    cancel_url: `${appUrl}/pricing?checkout=cancelled`,
  });

  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

export async function createPortalSession(
  userId: string,
  email: string | null,
  appUrl: string
): Promise<string> {
  const customer = await getOrCreateStripeCustomer(userId, email);
  const session = await getStripe().billingPortal.sessions.create({
    customer,
    return_url: `${appUrl}/billing`,
  });
  return session.url;
}

// ─── Subscription state sync (used by the webhook) ────────────────────────────

// Narrow view of a Stripe Subscription that tolerates API-version drift
// (current_period_* lives on the subscription in older versions, on the
// items in newer ones).
export interface SubscriptionLike {
  id: string;
  status: string;
  customer: string | { id: string };
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string> | null;
  current_period_start?: number;
  current_period_end?: number;
  items?: {
    data: Array<{
      current_period_start?: number;
      current_period_end?: number;
      price?: { lookup_key?: string | null } | null;
    }>;
  };
}

export function subscriptionPeriod(sub: SubscriptionLike): {
  start: number | null;
  end: number | null;
} {
  const item = sub.items?.data[0];
  return {
    start: sub.current_period_start ?? item?.current_period_start ?? null,
    end: sub.current_period_end ?? item?.current_period_end ?? null,
  };
}

export function subscriptionPlanKey(sub: SubscriptionLike): string | null {
  return (
    sub.metadata?.plan_key ??
    sub.items?.data[0]?.price?.lookup_key ??
    null
  );
}

export function unixToIso(unix: number | null): string | null {
  return unix === null ? null : new Date(unix * 1000).toISOString();
}

export async function upsertSubscription(sub: SubscriptionLike): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const userId = sub.metadata?.user_id ?? (await userIdForCustomer(customerId));
  if (!userId) {
    console.error(
      `[billing] subscription ${sub.id} has no resolvable user — skipping sync`
    );
    return;
  }
  const period = subscriptionPeriod(sub);

  const { error } = await getSupabaseAdmin().from("subscriptions").upsert({
    stripe_subscription_id: sub.id,
    user_id: userId,
    plan_key: subscriptionPlanKey(sub) ?? "unknown",
    status: sub.status,
    current_period_start: unixToIso(period.start),
    current_period_end: unixToIso(period.end),
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(`subscription sync failed: ${error.message}`);
  }
}
