// Stripe webhook — the source of truth for subscription state and monthly
// credit grants.
//
// Point a Stripe webhook endpoint at {APP_URL}/api/billing/webhook with
// events: checkout.session.completed, customer.subscription.created/updated/
// deleted/paused, invoice.paid, invoice.payment_failed. Set
// STRIPE_WEBHOOK_SECRET from the endpoint's signing secret.
//
// Idempotency (roadmap Gate 3: "billing webhook retries are idempotent"):
//   - every event id is recorded first; replays are ACKed and skipped
//   - credit grants carry a unique stripe_invoice_id — a re-delivered
//     invoice.paid can never grant twice
//   - subscription syncs are upserts keyed by subscription id

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, upsertSubscription, userIdForCustomer } from "@/lib/billing/stripe";
import type { SubscriptionLike } from "@/lib/billing/stripe";
import { getSupabaseAdmin } from "@/lib/connections";
import { PLANS, isPaidPlanKey } from "@/lib/billing/plans";
import { handleDirectSale } from "@/lib/sold-events";
import { trackEvent } from "@/lib/telemetry";

// Narrow view of a Checkout Session — enough to route payment-link sales.
interface CheckoutSessionLike {
  id: string;
  mode?: string;
  payment_link?: string | { id: string } | null;
  amount_total?: number | null;
}

// Narrow view of a Stripe Invoice tolerant of API-version drift (the parent
// subscription reference moved between versions).
interface InvoiceLike {
  id: string;
  customer: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  parent?: {
    subscription_details?: {
      subscription?: string | { id: string } | null;
      metadata?: Record<string, string> | null;
    } | null;
  } | null;
  lines?: {
    data: Array<{ period?: { start?: number; end?: number } | null }>;
  };
}

function invoiceSubscriptionMeta(
  invoice: InvoiceLike
): Record<string, string> | null {
  return invoice.parent?.subscription_details?.metadata ?? null;
}

async function handleInvoicePaid(invoice: InvoiceLike): Promise<void> {
  const meta = invoiceSubscriptionMeta(invoice);
  let userId = meta?.user_id ?? null;
  const planKey = meta?.plan_key ?? null;

  if (!userId) {
    const customerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id;
    if (customerId) userId = await userIdForCustomer(customerId);
  }
  if (!userId || !planKey || !isPaidPlanKey(planKey)) {
    // Not a subscription invoice we understand (e.g. one-off) — nothing to grant.
    console.log(`[billing/webhook] invoice ${invoice.id}: no plan grant applicable`);
    return;
  }

  const period = invoice.lines?.data[0]?.period;
  const start = period?.start ? new Date(period.start * 1000) : new Date();
  const end = period?.end
    ? new Date(period.end * 1000)
    : new Date(start.getTime() + 31 * 24 * 60 * 60 * 1000);

  const { error } = await getSupabaseAdmin().from("monthly_credit_grants").insert({
    user_id: userId,
    source: "invoice",
    stripe_invoice_id: invoice.id,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    credits_granted: PLANS[planKey].monthlyCredits,
  });
  // 23505 → this invoice already granted (webhook retry). Correct no-op.
  if (error && error.code !== "23505") {
    throw new Error(`credit grant failed: ${error.message}`);
  }
  if (!error) {
    await trackEvent(userId, "credits_granted", {
      planKey,
      credits: PLANS[planKey].monthlyCredits,
      invoiceId: invoice.id,
    });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[billing/webhook] STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // Signature verification requires the RAW body — do not JSON-parse first.
  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(
      rawBody,
      signature,
      secret
    );
  } catch (err) {
    console.error("[billing/webhook] signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency gate: record the event id first; a replay is ACKed untouched.
  const { error: dedupeError } = await getSupabaseAdmin()
    .from("stripe_webhook_events")
    .insert({ event_id: event.id, event_type: event.type });
  if (dedupeError) {
    if (dedupeError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[billing/webhook] event dedupe failed:", dedupeError.message);
    // Continue anyway — grant-level idempotency still protects credits.
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // Subscription checkouts sync via customer.subscription.* events.
        // Payment-link checkouts are DIRECT SALES: mark the inventory item
        // sold and end its listings on every other channel (anti-oversell).
        const session = event.data.object as unknown as CheckoutSessionLike;
        if (session.mode === "payment" && session.payment_link) {
          const paymentLinkId =
            typeof session.payment_link === "string"
              ? session.payment_link
              : session.payment_link.id;
          await handleDirectSale(
            paymentLinkId,
            session.id,
            session.amount_total ?? null
          );
          await trackEvent(null, "direct_sale", {
            paymentLinkId,
            amountTotal: session.amount_total ?? null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        await upsertSubscription(
          event.data.object as unknown as SubscriptionLike
        );
        break;
      }
      case "invoice.paid": {
        await handleInvoicePaid(event.data.object as unknown as InvoiceLike);
        break;
      }
      case "invoice.payment_failed": {
        // Subscription status moves to past_due via the subscription.updated
        // event; log for the ops trail.
        const invoice = event.data.object as unknown as InvoiceLike;
        console.warn(`[billing/webhook] payment failed for invoice ${invoice.id}`);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error(`[billing/webhook] handler failed for ${event.type}:`, err);
    // Non-2xx → Stripe retries. Safe because every handler is idempotent.
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
