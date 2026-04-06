// Browser-side Supabase client for use in Client Components.
// Stores the auth session in cookies (not localStorage) so the server can
// read it via the SSR server client on every request.

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
