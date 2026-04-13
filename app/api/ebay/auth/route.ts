import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// ─── GET /api/ebay/auth ───────────────────────────────────────────────────────
// Builds the eBay OAuth2 consent URL and redirects the seller there.
// Requires the seller to be authenticated with our app first.

const EBAY_AUTH_URL = "https://auth.ebay.com/oauth2/authorize";
const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
].join(" ");

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth gate — seller must be logged in to our app
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
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !ruName) {
    return NextResponse.json(
      { error: "eBay OAuth is not configured. Check EBAY_CLIENT_ID and EBAY_RUNAME." },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: ruName,
    scope: EBAY_SCOPES,
    // state encodes the user id so callback can verify session continuity
    state: Buffer.from(user.id).toString("base64url"),
  });

  return NextResponse.redirect(`${EBAY_AUTH_URL}?${params.toString()}`);
}
