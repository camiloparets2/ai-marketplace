// Billing + credits status for the signed-in user — safe metadata only.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getCreditStatus } from "@/lib/billing/credits";
import { getSupabaseAdmin } from "@/lib/connections";
import { PLANS, isPaidPlanKey } from "@/lib/billing/plans";

interface SubscriptionRow {
  plan_key: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let subscription: SubscriptionRow | null = null;
  try {
    const { data } = await getSupabaseAdmin()
      .from("subscriptions")
      .select("plan_key, status, current_period_end, cancel_at_period_end")
      .eq("user_id", user.id)
      .in("status", ["active", "trialing", "past_due"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<SubscriptionRow>();
    subscription = data ?? null;
  } catch {
    // Billing tables not migrated yet — report free-trial-only state.
  }

  const credits = await getCreditStatus(user.id);

  const planKey =
    subscription && isPaidPlanKey(subscription.plan_key)
      ? subscription.plan_key
      : "free_trial";

  return NextResponse.json({
    plan: {
      key: planKey,
      name: PLANS[planKey].name,
      monthlyCredits: PLANS[planKey].monthlyCredits,
    },
    subscriptionStatus: subscription?.status ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
    renewsAt: subscription?.current_period_end ?? credits?.periodEnd ?? null,
    creditsRemaining: credits?.creditsRemaining ?? null,
    creditsGranted: credits?.creditsGranted ?? null,
  });
}
