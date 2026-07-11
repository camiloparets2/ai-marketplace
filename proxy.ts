// Supabase session refresh + optimistic page gate. API routes and every
// server-side mutation still enforce authorization independently.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const PROTECTED_PREFIXES = [
  "/billing",
  "/inventory",
  "/review",
  "/dashboard",
  "/channels",
] as const;

function isProtectedPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/reset-password" ||
    PROTECTED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  );
}

function signedOutRedirect(req: NextRequest, authUnavailable = false): NextResponse {
  const redirectUrl = req.nextUrl.clone();
  if (req.nextUrl.pathname === "/") {
    redirectUrl.pathname = "/welcome";
    redirectUrl.search = "";
  } else {
    redirectUrl.pathname = "/login";
    redirectUrl.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    if (authUnavailable) redirectUrl.searchParams.set("error", "auth_unavailable");
  }
  return NextResponse.redirect(redirectUrl);
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // A missing auth configuration must never unlock protected pages.
  if (!url || !anonKey) return signedOutRedirect(req, true);

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of cookiesToSet) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user && isProtectedPath(req.nextUrl.pathname)) {
      const redirect = signedOutRedirect(req);
      for (const cookie of res.cookies.getAll()) redirect.cookies.set(cookie);
      return redirect;
    }
  } catch (error) {
    console.error("[proxy] Supabase auth check failed", error);
    return signedOutRedirect(req, true);
  }

  return res;
}

export const config = {
  matcher: [
    "/",
    "/reset-password",
    "/billing/:path*",
    "/inventory/:path*",
    "/review/:path*",
    "/dashboard/:path*",
    "/channels/:path*",
  ],
};
