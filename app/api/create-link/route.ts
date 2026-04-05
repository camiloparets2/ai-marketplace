// Route segment config — Stripe calls are fast but set a generous ceiling.
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

// Lazily initialised so the module doesn't crash during build if
// STRIPE_SECRET_KEY is not yet set in the environment.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateLinkBody {
  title: string;
  // Price in USD dollars (e.g. 29.99). Converted to cents for Stripe.
  price: number;
  // Auto-generated description from the extraction result. Optional.
  description?: string;
}

interface CreateLinkSuccess {
  url: string;
}

interface CreateLinkError {
  error: string;
  retryable: boolean;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest
): Promise<NextResponse<CreateLinkSuccess | CreateLinkError>> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const incomingKey = req.headers.get("x-api-key");
  if (
    !process.env.APP_INTERNAL_BETA_KEY ||
    incomingKey !== process.env.APP_INTERNAL_BETA_KEY
  ) {
    return NextResponse.json({ error: "Unauthorized", retryable: false }, { status: 401 });
  }

  // ── Parse + validate body ───────────────────────────────────────────────────
  let body: CreateLinkBody;
  try {
    body = (await req.json()) as CreateLinkBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body", retryable: false },
      { status: 400 }
    );
  }

  const { title, price, description } = body;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json(
      { error: "A listing title is required", retryable: false },
      { status: 400 }
    );
  }

  if (typeof price !== "number" || price <= 0 || !isFinite(price)) {
    return NextResponse.json(
      { error: "Price must be a positive number", retryable: false },
      { status: 400 }
    );
  }

  // Stripe requires prices in the smallest currency unit (cents for USD).
  // Round to avoid floating-point issues: $29.99 → 2999 cents.
  const unitAmount = Math.round(price * 100);

  // ── Stripe: create product → price → payment link ───────────────────────────
  // Three separate API calls. If any fail, we surface a clear error before the
  // user gets a broken or non-existent link — per the design doc constraint.
  try {
    const stripe = getStripe();

    const product = await stripe.products.create({
      name: title.trim(),
      ...(description ? { description: description.trim() } : {}),
    });

    const stripePrice = await stripe.prices.create({
      product: product.id,
      unit_amount: unitAmount,
      currency: "usd",
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: stripePrice.id, quantity: 1 }],
    });

    return NextResponse.json({ url: paymentLink.url });
  } catch (err) {
    // Stripe errors: StripeCardError, StripeInvalidRequestError, StripeAPIError, etc.
    // All extend StripeError which has a .message property.
    const message =
      err instanceof Error ? err.message : "Unknown Stripe error";
    console.error("[create-link] Stripe error:", message);

    return NextResponse.json(
      {
        error:
          "Could not create your listing link. Please check your details and try again.",
        retryable: true,
      },
      { status: 502 }
    );
  }
}
