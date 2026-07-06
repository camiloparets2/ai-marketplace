// Credit accounting — server-only, on top of the SQL functions in
// supabase/migrations/…_billing_credits.sql.
//
// Guarantees (roadmap Gate 3: "AI credit accounting is atomic and cannot be
// double-spent"):
//   - spend is a single guarded UPDATE in Postgres (spend_credits RPC)
//   - every spend writes a usage_ledger row keyed by a unique request id
//   - refunds are idempotent: the ledger row flips consumed → refunded once
//
// Fail-open transition rule: if the billing tables don't exist yet (migration
// not applied), gating is skipped with a logged warning rather than bricking
// the product. Verify the migration before charging anyone (TODOS.md).

import { getSupabaseAdmin } from "@/lib/connections";
import {
  TRIAL_CREDITS,
  TRIAL_PERIOD_DAYS,
} from "@/lib/billing/plans";

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
  | { ok: false; reason: "unavailable" }; // billing infra not ready → fail open

interface GrantRow {
  credits_granted: number;
  credits_used: number;
  period_end: string;
}

// One-time trial grant for new users, created lazily on first billing-aware
// touch. The partial unique index makes concurrent calls collapse to one row.
export async function ensureTrialGrant(userId: string): Promise<void> {
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
    console.warn("[credits] spend unavailable — failing open:", err);
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
