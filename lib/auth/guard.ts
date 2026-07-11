// Request authentication for API routes. Every protected operation requires
// a real Supabase user session so usage, marketplace tokens, and inventory are
// always attributable to one account.

import type { User } from "@supabase/supabase-js";
import { getRequestUser } from "@/lib/supabase/server";

export async function requireUser(): Promise<User | null> {
  return getRequestUser();
}
