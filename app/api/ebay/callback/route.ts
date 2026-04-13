import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";

// ─── GET /api/ebay/callback ───────────────────────────────────────────────────
// eBay redirects sellers here after they approve (or deny) our OAuth request.
// Exchanges the authorization code for access + refresh tokens and persists
// them to seller_profiles so future API calls can act on the seller's behalf.

const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  // eBay sends error=access_denied if the seller cancelled
  if (error || !code) {
    console.warn("[ebay/callback] OAuth denied or missing code:", error);
    return NextResponse.redirect(
      new URL("/dashboard?ebay=denied", req.url)
    );
  }

  // Auth gate — seller must still have a valid session in our app
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: () => {},
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    console.warn("[ebay/callback] No authenticated user during callback");
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    console.error("[ebay/callback] Missing eBay env vars");
    return NextResponse.redirect(
      new URL("/dashboard?ebay=error&reason=config", req.url)
    );
  }

  // Exchange authorization code for tokens
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  try {
    const tokenRes = await fetch(EBAY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ruName,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "(unreadable)");
      console.error("[ebay/callback] Token exchange failed:", tokenRes.status, body);
      return NextResponse.redirect(
        new URL("/dashboard?ebay=error&reason=token", req.url)
      );
    }

    tokenData = await tokenRes.json();
    console.log("[ebay/callback] Token exchange succeeded for user:", user.id);
  } catch (err) {
    console.error("[ebay/callback] Token exchange threw:", err);
    return NextResponse.redirect(
      new URL("/dashboard?ebay=error&reason=network", req.url)
    );
  }

  // Calculate absolute expiry timestamp
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  // Upsert tokens into seller_profiles
  const { error: dbError } = await supabaseAdmin
    .from("seller_profiles")
    .upsert(
      {
        id: user.id,
        ebay_access_token: tokenData.access_token,
        ebay_refresh_token: tokenData.refresh_token,
        ebay_token_expiry: expiresAt,
      },
      { onConflict: "id" }
    );

  if (dbError) {
    console.error("[ebay/callback] Failed to save tokens:", dbError.message);
    return NextResponse.redirect(
      new URL("/dashboard?ebay=error&reason=db", req.url)
    );
  }

  console.log("[ebay/callback] eBay tokens saved for user:", user.id);
  return NextResponse.redirect(new URL("/dashboard?ebay=connected", req.url));
}
