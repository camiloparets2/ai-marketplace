// Shared Stripe Payment Link creation — used by /api/create-link (legacy
// single-button flow) and /api/publish (the "direct link" option in the
// multi-platform publish flow).

import Stripe from "stripe";

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

export interface PaymentLinkResult {
  url: string;
  // Payment link id — stored on the marketplace listing so the billing
  // webhook can match a completed checkout back to the inventory item, and
  // so the link can be deactivated when the item sells.
  id: string;
}

// Creates product → price → payment link.
// price is in USD dollars; converted to cents for Stripe.
export async function createPaymentLink(
  title: string,
  price: number,
  description?: string
): Promise<PaymentLinkResult> {
  const stripe = getStripe();

  const product = await stripe.products.create({
    name: title.trim(),
    ...(description ? { description: description.trim() } : {}),
  });

  const stripePrice = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round(price * 100),
    currency: "usd",
  });

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: stripePrice.id, quantity: 1 }],
  });

  return { url: paymentLink.url, id: paymentLink.id };
}

// Deactivates a payment link. Stripe keeps links active after purchase, so
// this is what prevents a second buyer paying for a sold one-of-one item.
export async function deactivatePaymentLink(id: string): Promise<void> {
  await getStripe().paymentLinks.update(id, { active: false });
}
