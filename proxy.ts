// Supabase SSR middleware — must run on every request so that:
//   1. Expiring access tokens are silently refreshed before they hit a route.
//   2. Unauthenticated visitors to protected pages are redirected to /login.
//
// Without this, users with an expired token would get a 401 from the API even
// though they appear "logged in", because the refresh only happens here.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  // Build a mutable response so we can forward refreshed cookies downstream.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write refreshed cookies onto both the request and the response so
          // downstream Server Components see the up-to-date session.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getUser() validates the JWT with Anthropic's servers — safe to use for
  // auth gating. getSession() only reads the local cookie and can be spoofed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicPage =
    pathname.startsWith("/login") ||
    pathname.startsWith("/explore") ||
    pathname.startsWith("/success");

  // Redirect unauthenticated users away from protected pages.
  // /explore and /success are public — buyers can browse and complete purchases.
  if (!user && !isPublicPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redirect already-authenticated users away from the login page.
  if (user && pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

// Only run middleware on page routes — not on static assets or API routes.
// API routes handle their own auth via supabase.auth.getUser() inside the handler.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
