// Rate limiting for expensive / abuse-prone routes (server-only).
//
// Backed by the atomic bump_rate() Postgres function — one round trip, no
// read-modify-write race. Keys are scoped to the signed-in user where
// available, with an IP fallback for any future anonymous route.
//
// FAIL-CLOSED: when the limiter itself is unavailable (DB blip, migration
// missing) the caller gets "unavailable" and must respond with a retriable
// 503 WITHOUT performing the expensive work. An unmetered path to Claude is
// worse than a brief outage.

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

export type RateDecision = "allowed" | "limited" | "unavailable";

/** "allowed" → proceed; "limited" → 429; "unavailable" → retriable 503,
 *  and the caller must NOT perform the guarded work. */
export async function checkRateLimit(
  rule: RateRule,
  identity: string
): Promise<RateDecision> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("bump_rate", {
      p_key: `${rule.name}:${identity}`,
      p_window_secs: rule.windowSecs,
      p_max: rule.max,
    });
    if (error) throw new Error(error.message);
    return data !== false ? "allowed" : "limited";
  } catch (err) {
    console.error(`[rate-limit] ${rule.name} check failed — blocking:`, err);
    return "unavailable";
  }
}

// Shared 503 body for the fail-closed paths so every route says the same
// retriable thing.
export const RATE_LIMIT_UNAVAILABLE_MESSAGE =
  "We couldn't verify your request rate just now — please try again in a moment.";
