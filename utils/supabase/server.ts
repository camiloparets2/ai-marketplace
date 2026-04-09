// Server-side Supabase client for use in Server Components and Server Actions.
// Reads and writes auth cookies via next/headers so the session stays fresh.
// Do NOT import this in Client Components — use utils/supabase/client.ts instead.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — the middleware handles
            // refreshing the session cookie before it reaches here.
          }
        },
      },
    }
  );
}
