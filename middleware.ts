// Session refresh + auth gate.
//
// Two jobs, per @supabase/ssr guidance:
//   1. Refresh the Supabase session cookie on matched requests so server
//      code always sees a live session.
//   2. Redirect signed-out users from protected pages to /login.
//
// When Supabase auth env vars are absent (fresh clone, CI), the middleware
// passes everything through — the app then runs in legacy beta-key mode.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Pages that need a signed-in user. API routes enforce auth themselves
// (lib/auth/guard.ts) so they can return JSON 401s instead of redirects.
const PROTECTED_PAGES = ["/", "/reset-password"];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.next(); // legacy beta-key mode

  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          req.cookies.set(name, value);
        }
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of cookiesToSet) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refreshes the token when expired — must be called before any redirect
  // decision so the cookie update is preserved on the response.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && PROTECTED_PAGES.includes(req.nextUrl.pathname)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search =
      req.nextUrl.pathname === "/"
        ? ""
        : `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  // Only pages that read or gate on the session. API routes, static assets,
  // and public pages (login, privacy, terms, connect landings) are excluded.
  matcher: ["/", "/reset-password"],
};
