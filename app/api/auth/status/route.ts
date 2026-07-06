// Safe auth status for the client: who is signed in, never anything secret.
// (Roadmap requirement: "/api/auth/status returns safe user metadata only".)

import { NextResponse } from "next/server";
import { getRequestUser, isSupabaseAuthConfigured } from "@/lib/supabase/server";

export async function GET(): Promise<NextResponse> {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json({
      configured: false,
      authenticated: false,
      email: null,
    });
  }

  const user = await getRequestUser();
  return NextResponse.json({
    configured: true,
    authenticated: user !== null,
    email: user?.email ?? null,
  });
}
