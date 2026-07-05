// Subscription plan catalog — the single source of truth for plan keys,
// credit amounts, and PLACEHOLDER prices (roadmap table, market-typical
// numbers; adjust before public launch — changing priceUsd here creates a
// new Stripe price at next checkout via the lookup-key flow, old subscribers
// keep their old price).
//
// Credits are "AI listing drafts": 1 credit = 1 photo analyzed by Claude
// Vision (/api/analyze). Manual edits, publishing, and syncing never consume
// credits (roadmap rule).

export interface Plan {
  key: PlanKey;
  name: string;
  monthlyCredits: number;
  // USD per month. 0 → not purchasable through Stripe (trial).
  priceUsd: number;
  blurb: string;
}

export type PlanKey = "free_trial" | "starter" | "pro" | "power";

export const TRIAL_PLAN_KEY: PlanKey = "free_trial";
export const TRIAL_CREDITS = 10;
export const TRIAL_PERIOD_DAYS = 30;

export const PLANS: Record<PlanKey, Plan> = {
  free_trial: {
    key: "free_trial",
    name: "Free Trial",
    monthlyCredits: TRIAL_CREDITS,
    priceUsd: 0,
    blurb: "Try the full workflow — 10 AI listing drafts, once.",
  },
  starter: {
    key: "starter",
    name: "Starter",
    monthlyCredits: 50,
    priceUsd: 9.99,
    blurb: "For casual resellers listing a few items a week.",
  },
  pro: {
    key: "pro",
    name: "Pro Reseller",
    monthlyCredits: 250,
    priceUsd: 29.99,
    blurb: "For consistent sellers who list every day.",
  },
  power: {
    key: "power",
    name: "Power Seller",
    monthlyCredits: 1000,
    priceUsd: 79.99,
    blurb: "High-volume sourcing and bulk listing.",
  },
};

export const PAID_PLAN_KEYS: ReadonlyArray<PlanKey> = [
  "starter",
  "pro",
  "power",
];

export function isPaidPlanKey(value: string): value is PlanKey {
  return (PAID_PLAN_KEYS as readonly string[]).includes(value);
}

// Cost per AI action, in credits (roadmap: "AI listing from photos: 1 credit").
export const CREDIT_COST_AI_EXTRACTION = 1;
