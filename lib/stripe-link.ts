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

// Creates product → price → payment link and returns the shareable URL.
// price is in USD dollars; converted to cents for Stripe.
export async function createPaymentLink(
  title: string,
  price: number,
  description?: string
): Promise<string> {
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

  return paymentLink.url;
}
