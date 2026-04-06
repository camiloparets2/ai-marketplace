// Server-side Supabase admin client.
// Uses the service role key so inserts bypass Row Level Security —
// this file must NEVER be imported from client components or browser code.
// The service role key is only available server-side (no NEXT_PUBLIC_ prefix).

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing Supabase environment variables. " +
      "Ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set."
  );
}

// Single shared client — safe to reuse across requests in the same serverless
// instance because createClient is stateless (no connection pool to exhaust).
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    // Disable auto-refreshing tokens — this is a server-side service role client,
    // not a user session. Prevents unnecessary background work in serverless.
    autoRefreshToken: false,
    persistSession: false,
  },
});
