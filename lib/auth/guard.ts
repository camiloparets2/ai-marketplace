// Request authentication for API routes. Every protected operation requires
// a real Supabase user session, so usage, marketplace tokens, and inventory
// are always attributable to one account. The legacy pre-shared beta key
// (x-api-key) is gone: it authenticated nobody, was shipped to every browser
// via NEXT_PUBLIC_*, and let unmetered calls through — fail-closed now.

import type { User } from "@supabase/supabase-js";
import { getRequestUser } from "@/lib/supabase/server";

export async function requireUser(): Promise<User | null> {
  return getRequestUser();
}
