// Request authentication for API routes.
//
// Auth model (auth-foundation phase):
//   1. Supabase session (cookie) — the real path. Identifies the user, which
//      user-scoped features (marketplace connections, publishing) require.
//   2. Pre-shared beta key (x-api-key) — LEGACY fallback kept only so the
//      original Phase 1 testers and curl smoke tests keep working for the
//      stateless routes (/api/analyze, /api/create-link). It carries no user
//      identity, so user-scoped routes must use requireUser() instead.
//      Remove at Gate 2 (see TODOS.md).

import type { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getRequestUser } from "@/lib/supabase/server";

export function hasValidBetaKey(req: NextRequest): boolean {
  const incomingKey = req.headers.get("x-api-key");
  return Boolean(
    process.env.APP_INTERNAL_BETA_KEY &&
      incomingKey === process.env.APP_INTERNAL_BETA_KEY
  );
}

/**
 * For stateless routes: a signed-in user OR the legacy beta key.
 * Returns the user when there is one (may be null with a valid key).
 */
export async function authenticateRequest(
  req: NextRequest
): Promise<{ authorized: boolean; user: User | null }> {
  const user = await getRequestUser();
  if (user) return { authorized: true, user };
  return { authorized: hasValidBetaKey(req), user: null };
}

/**
 * For user-scoped routes (marketplace connections, publishing): a real
 * session only — the beta key is not sufficient because there is no user
 * to scope the data to.
 */
export async function requireUser(): Promise<User | null> {
  return getRequestUser();
}
