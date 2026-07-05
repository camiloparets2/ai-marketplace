// Stripe Customer Portal session for the signed-in user — payment method,
// plan changes, invoices, and cancellation all live there (roadmap Gate 2).

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { createPortalSession } from "@/lib/billing/stripe";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;

  try {
    const url = await createPortalSession(user.id, user.email ?? null, appUrl);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing/portal]", err);
    return NextResponse.json(
      { error: "Could not open the billing portal. Please try again." },
      { status: 502 }
    );
  }
}
