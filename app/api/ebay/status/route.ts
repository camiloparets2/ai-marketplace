import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";

// ─── GET /api/ebay/status ─────────────────────────────────────────────────────
// Returns whether the authenticated seller has eBay connected.
// Used by the Dashboard to show the Connect / Connected badge.

export async function GET(req: NextRequest): Promise<NextResponse> {
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data } = await supabaseAdmin
    .from("seller_profiles")
    .select("ebay_access_token, ebay_token_expiry")
    .eq("id", user.id)
    .single();

  const connected = !!(data?.ebay_access_token);
  const expired = data?.ebay_token_expiry
    ? new Date(data.ebay_token_expiry) < new Date()
    : true;

  return NextResponse.json({ connected, tokenExpired: expired });
}
