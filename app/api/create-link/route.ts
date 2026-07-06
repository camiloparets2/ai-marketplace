// Route segment config — Stripe calls are fast but set a generous ceiling.
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { createPaymentLink } from "@/lib/stripe-link";
import { authenticateRequest } from "@/lib/auth/guard";

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
  // Session or legacy beta key — same policy as /api/analyze.
  const { authorized } = await authenticateRequest(req);
  if (!authorized) {
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

  // ── Stripe: create product → price → payment link ───────────────────────────
  // Three separate API calls (see lib/stripe-link.ts). If any fail, we surface
  // a clear error before the user gets a broken or non-existent link.
  try {
    const { url } = await createPaymentLink(title, price, description);
    return NextResponse.json({ url });
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
