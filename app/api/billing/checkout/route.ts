// Creates a Stripe subscription Checkout Session for the signed-in user.
// Body: { plan: "starter" | "pro" | "power" } → { url }

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { createSubscriptionCheckout } from "@/lib/billing/stripe";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to subscribe" }, { status: 401 });
  }

  let plan: unknown;
  try {
    ({ plan } = (await req.json()) as { plan?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof plan !== "string") {
    return NextResponse.json({ error: "Missing plan" }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;

  try {
    const url = await createSubscriptionCheckout(
      user.id,
      user.email ?? null,
      plan,
      appUrl
    );
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing/checkout]", err);
    const message =
      err instanceof Error && err.message.startsWith("Unknown plan")
        ? err.message
        : "Could not start checkout. Please try again.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
