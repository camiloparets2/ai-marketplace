// OAuth callback for eBay / Etsy. Verifies the CSRF state cookie, exchanges
// the authorization code for tokens, persists the connection, and bounces the
// user back to the app with a status query param the UI can toast on.

import { NextRequest, NextResponse } from "next/server";
import { ebayExchangeCode } from "@/lib/platforms/ebay";
import { etsyExchangeCode } from "@/lib/platforms/etsy";
import { saveConnection } from "@/lib/connections";
import { requireUser } from "@/lib/auth/guard";

function backToApp(origin: string, params: Record<string, string>): NextResponse {
  const url = new URL("/", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url.toString());
  // One-shot cookies — always clear them regardless of outcome.
  res.cookies.delete("oauth_state_ebay");
  res.cookies.delete("oauth_state_etsy");
  res.cookies.delete("etsy_code_verifier");
  return res;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await params;
  const origin = req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(`oauth_state_${platform}`)?.value;

  if (platform !== "ebay" && platform !== "etsy") {
    return NextResponse.json(
      { error: `Unknown platform: ${platform}` },
      { status: 404 }
    );
  }

  if (!code) {
    // User declined consent, or the platform returned an error.
    const reason =
      req.nextUrl.searchParams.get("error_description") ??
      req.nextUrl.searchParams.get("error") ??
      "Authorization was cancelled";
    return backToApp(origin, { connect_error: reason });
  }

  if (!state || !expectedState || state !== expectedState) {
    return backToApp(origin, {
      connect_error: "Security check failed — please try connecting again.",
    });
  }

  // The consent flow started from a signed-in session; it must still be one.
  const user = await requireUser();
  if (!user) {
    return backToApp(origin, {
      connect_error: "You were signed out during the connection — sign in and try again.",
    });
  }

  try {
    if (platform === "ebay") {
      await saveConnection({ ...(await ebayExchangeCode(code)), userId: user.id });
    } else {
      const verifier = req.cookies.get("etsy_code_verifier")?.value;
      if (!verifier) {
        return backToApp(origin, {
          connect_error:
            "Connection session expired — please try connecting again.",
        });
      }
      await saveConnection({
        ...(await etsyExchangeCode(code, verifier, origin)),
        userId: user.id,
      });
    }
    return backToApp(origin, { connected: platform });
  } catch (err) {
    console.error(`[oauth:${platform}] token exchange failed`, err);
    const message =
      err instanceof Error ? err.message : "Connection failed. Please retry.";
    return backToApp(origin, { connect_error: message });
  }
}
