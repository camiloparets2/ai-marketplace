// Auth callback — the single landing point for every Supabase auth link:
//   Google OAuth consent  →  ?code=…&next=/
//   signup confirmation   →  ?code=…&next=/
//   password reset email  →  ?code=…&next=/reset-password
//
// Exchanges the code for a session cookie, then forwards to a validated
// same-origin path (open-redirect safe — see lib/auth/redirect.ts).

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/auth/redirect";
import { trackEvent } from "@/lib/telemetry";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get("code");
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const origin = req.nextUrl.origin;

  if (!code) {
    const reason =
      req.nextUrl.searchParams.get("error_description") ??
      "Sign-in link was invalid or expired. Please try again.";
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(reason)}`
    );
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent(error.message)}`
      );
    }
    // Funnel: every successful auth-link landing (Google, signup confirm,
    // recovery) counts as a sign-in.
    await trackEvent(data.session?.user.id ?? null, "sign_in", { next });
  } catch (err) {
    console.error("[auth/callback] code exchange failed", err);
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent("Sign-in failed. Please try again.")}`
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
