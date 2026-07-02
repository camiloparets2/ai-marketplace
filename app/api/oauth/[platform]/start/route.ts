// Starts the OAuth consent flow for an API platform (eBay or Etsy).
// Browser navigation route — CSRF is handled with a state cookie verified in
// the callback. Phase 1 is single-seller, so no user session is involved.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { ebayAuthorizeUrl } from "@/lib/platforms/ebay";
import { etsyAuthorizeUrl, generatePkce } from "@/lib/platforms/etsy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await params;
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
