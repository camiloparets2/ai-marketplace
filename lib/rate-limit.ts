// Rate limiting for expensive / abuse-prone routes (server-only).
//
// Backed by the atomic bump_rate() Postgres function — one round trip, no
// read-modify-write race. Keys are scoped per identity: the signed-in user
// id when there is one, otherwise the caller's IP (good enough to blunt
// anonymous abuse of the legacy beta-key path).
//
// Fail-open: if the limiter itself errors (migration not applied, DB blip),
// the request proceeds and we log — availability beats perfect metering, and
// the AI route is still credit-gated per user.

import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/connections";

export interface RateRule {
  name: string;
  windowSecs: number;
  max: number;
}

// Per-identity budgets, sized for a human reseller and hostile to scripts.
export const RATE_RULES = {
  // Claude Vision calls — the expensive path.
  analyze: { name: "analyze", windowSecs: 3600, max: 60 },
  // Marketplace fan-out publishes.
  publish: { name: "publish", windowSecs: 3600, max: 60 },
  // Stripe checkout/portal session creation.
  billing: { name: "billing", windowSecs: 3600, max: 20 },
} satisfies Record<string, RateRule>;

export function requestIdentity(req: NextRequest, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `ip:${ip}`;
}

/** True → allowed; false → over the limit (respond 429). */
export async function checkRateLimit(
  rule: RateRule,
  identity: string
): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("bump_rate", {
      p_key: `${rule.name}:${identity}`,
      p_window_secs: rule.windowSecs,
      p_max: rule.max,
    });
    if (error) throw new Error(error.message);
    return data !== false;
  } catch (err) {
    console.warn(`[rate-limit] ${rule.name} check failed — allowing:`, err);
    return true;
  }
}
