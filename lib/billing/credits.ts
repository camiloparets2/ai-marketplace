// Credit accounting — server-only, on top of the SQL functions in
// supabase/migrations/…_billing_credits.sql.
//
// Guarantees (roadmap Gate 3: "AI credit accounting is atomic and cannot be
// double-spent"):
//   - spend is a single guarded UPDATE in Postgres (spend_credits RPC)
//   - every spend writes a usage_ledger row keyed by a unique request id
//   - refunds are idempotent: the ledger row flips consumed → refunded once
//
// FAIL-CLOSED: when the billing backend is unavailable, spendCredits returns
// { ok: false, reason: "unavailable" } and the caller must respond with a
// retriable 503 WITHOUT performing the paid work. An unmetered path to
// Claude is worse than a brief outage.

import { getSupabaseAdmin } from "@/lib/connections";
import { currentEbayEnvironment } from "@/lib/ebay-env";
import {
  TRIAL_CREDITS,
  TRIAL_PERIOD_DAYS,
} from "@/lib/billing/plans";

// SANDBOX BYPASS: sandbox and production share one Supabase project, so
// monthly_credit_grants IS live customer quota. Testing against the sandbox
// build must never enforce or decrement it (live incident: a sandbox run
// drained the grant to "0 credits left"). When bypassed, no billing table
// is touched at all. DISABLE_CREDIT_ENFORCEMENT=true is the explicit dev
// override for non-sandbox test environments.
export const BYPASS_CREDITS_REMAINING = 999;

function creditsBypassed(): boolean {
  return (
    currentEbayEnvironment() === "sandbox" ||
    process.env.DISABLE_CREDIT_ENFORCEMENT === "true"
  );
}

export interface CreditStatus {
  creditsRemaining: number;
  creditsGranted: number;
  // ISO timestamp when the active grant ends (renewal / trial expiry), or null.
  periodEnd: string | null;
  // Whether any grant (even expired) exists — false → brand-new user.
  hasEverHadGrant: boolean;
}

export type SpendResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "no_credits"; status: CreditStatus }
  // Billing backend unreachable — callers fail closed (retriable 503).
  | { ok: false; reason: "unavailable" };

interface GrantRow {
  credits_granted: number;
  credits_used: number;
  period_end: string;
}

// One-time trial grant for new users, created lazily on first billing-aware
// touch. The partial unique index makes concurrent calls collapse to one row.
export async function ensureTrialGrant(userId: string): Promise<void> {
  if (creditsBypassed()) return; // sandbox must never write a grant row
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("monthly_credit_grants")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`grant lookup failed: ${error.message}`);
  if ((count ?? 0) > 0) return;

  const now = new Date();
  const end = new Date(now.getTime() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const { error: insertError } = await supabase.from("monthly_credit_grants").insert({
    user_id: userId,
    source: "trial",
    period_start: now.toISOString(),
    period_end: end.toISOString(),
    credits_granted: TRIAL_CREDITS,
  });
  // 23505 → another request already created the trial. Fine.
  if (insertError && insertError.code !== "23505") {
    throw new Error(`trial grant failed: ${insertError.message}`);
  }
}

export async function getCreditStatus(userId: string): Promise<CreditStatus | null> {
  if (creditsBypassed()) {
    // Sandbox/dev: report a full synthetic allowance, touch nothing.
    return {
      creditsRemaining: BYPASS_CREDITS_REMAINING,
      creditsGranted: BYPASS_CREDITS_REMAINING,
      periodEnd: null,
      hasEverHadGrant: true,
    };
  }
  try {
    const supabase = getSupabaseAdmin();
    await ensureTrialGrant(userId);

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("monthly_credit_grants")
      .select("credits_granted, credits_used, period_end")
      .eq("user_id", userId)
      .lte("period_start", nowIso)
      .gt("period_end", nowIso)
      .order("period_end", { ascending: false })
      .limit(1)
      .maybeSingle<GrantRow>();
    if (error) throw new Error(error.message);

    if (!data) {
      return {
        creditsRemaining: 0,
        creditsGranted: 0,
        periodEnd: null,
        hasEverHadGrant: true, // ensureTrialGrant guarantees at least one row
      };
    }
    return {
      creditsRemaining: data.credits_granted - data.credits_used,
      creditsGranted: data.credits_granted,
      periodEnd: data.period_end,
      hasEverHadGrant: true,
    };
  } catch (err) {
    console.warn("[credits] status unavailable (migration applied?):", err);
    return null;
  }
}

/**
 * Atomically consume `amount` credits and record the ledger row.
 * `requestId` must be unique per AI call (crypto.randomUUID()).
 */
export async function spendCredits(
  userId: string,
  amount: number,
  action: string,
  requestId: string
): Promise<SpendResult> {
  if (creditsBypassed()) {
    return { ok: true, remaining: BYPASS_CREDITS_REMAINING };
  }
  try {
    const supabase = getSupabaseAdmin();
    await ensureTrialGrant(userId);

    const { data, error } = await supabase.rpc("spend_credits", {
      p_user_id: userId,
      p_amount: amount,
    });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as GrantRow[];
    if (rows.length === 0) {
      const status = await getCreditStatus(userId);
      return {
        ok: false,
        reason: "no_credits",
        status: status ?? {
          creditsRemaining: 0,
          creditsGranted: 0,
          periodEnd: null,
          hasEverHadGrant: true,
        },
      };
    }

    // Audit trail. A ledger failure must not un-spend silently — log loudly.
    const { error: ledgerError } = await supabase.from("usage_ledger").insert({
      user_id: userId,
      action,
      credits: amount,
      status: "consumed",
      request_id: requestId,
    });
    if (ledgerError) {
      console.error("[credits] ledger write failed:", ledgerError.message);
    }

    const row = rows[0];
    return { ok: true, remaining: row.credits_granted - row.credits_used };
  } catch (err) {
    console.error("[credits] spend unavailable — blocking the paid call:", err);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Refund a previous spend (AI call failed before producing useful output).
 * Idempotent: flipping the ledger row consumed → refunded gates the credit
 * return, so webhook-style retries can't refund twice.
 */
export async function refundCredits(
  userId: string,
  amount: number,
  requestId: string
): Promise<void> {
  if (creditsBypassed()) return; // nothing was spent, nothing to refund
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("usage_ledger")
      .update({ status: "refunded" })
      .eq("request_id", requestId)
      .eq("status", "consumed")
      .select("id");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return; // already refunded or never spent

    const { error: rpcError } = await supabase.rpc("refund_credits", {
      p_user_id: userId,
      p_amount: amount,
    });
    if (rpcError) throw new Error(rpcError.message);
  } catch (err) {
    // A missed refund costs the user one credit — log for manual fix-up.
    console.error(`[credits] refund failed for request ${requestId}:`, err);
  }
}
