// Starts the OAuth consent flow for an API platform (eBay or Etsy).
// Browser navigation route — CSRF is handled with a state cookie verified in
// the callback. Requires a signed-in user: the resulting tokens are saved
// against their account.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { ebayAuthorizeUrl } from "@/lib/platforms/ebay";
import { etsyAuthorizeUrl, generatePkce } from "@/lib/platforms/etsy";
import { shopifyAuthorizeUrl } from "@/lib/platforms/shopify";
import { requireUser } from "@/lib/auth/guard";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await params;

  // Connections belong to a user — send signed-out visitors to sign in first.
  const user = await requireUser();
  if (!user) {
    return NextResponse.redirect(
      `${req.nextUrl.origin}/login?next=${encodeURIComponent(`/api/oauth/${platform}/start`)}`
    );
  }

  const state = randomBytes(16).toString("hex");

  let authorizeUrl: string;
  const cookies: Array<{ name: string; value: string }> = [
    { name: `oauth_state_${platform}`, value: state },
  ];

  try {
    if (platform === "ebay") {
      authorizeUrl = ebayAuthorizeUrl(state);
    } else if (platform === "etsy") {
      const { verifier, challenge } = generatePkce();
      cookies.push({ name: "etsy_code_verifier", value: verifier });
      authorizeUrl = etsyAuthorizeUrl(state, challenge, req.nextUrl.origin);
    } else if (platform === "shopify") {
      // Shopify consent lives on the merchant's own domain, so the shop must
      // be provided: /api/oauth/shopify/start?shop=my-store.myshopify.com
      const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
      if (!shop) {
        return NextResponse.redirect(
          `${req.nextUrl.origin}/channels?connect_error=${encodeURIComponent(
            "Enter your .myshopify.com store domain to connect Shopify."
          )}`
        );
      }
      authorizeUrl = shopifyAuthorizeUrl(shop, state, req.nextUrl.origin);
    } else {
      return NextResponse.json(
        { error: `Unknown platform: ${platform}` },
        { status: 404 }
      );
    }
  } catch (err) {
    // Missing env credentials — send the user back with a readable message.
    const message = err instanceof Error ? err.message : "OAuth setup failed";
    return NextResponse.redirect(
      `${req.nextUrl.origin}/?connect_error=${encodeURIComponent(message)}`
    );
  }

  const res = NextResponse.redirect(authorizeUrl);
  for (const cookie of cookies) {
    res.cookies.set(cookie.name, cookie.value, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 10 * 60, // consent flows finish in minutes; 10 min is generous
      path: "/",
    });
  }
  return res;
}
