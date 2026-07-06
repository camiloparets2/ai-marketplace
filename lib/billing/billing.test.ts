import { describe, it, expect } from "vitest";
import {
  PLANS,
  PAID_PLAN_KEYS,
  isPaidPlanKey,
  TRIAL_CREDITS,
  CREDIT_COST_AI_EXTRACTION,
} from "@/lib/billing/plans";
import {
  subscriptionPeriod,
  subscriptionPlanKey,
  unixToIso,
} from "@/lib/billing/stripe";

describe("plan catalog", () => {
  it("every paid plan has a positive price and credits", () => {
    for (const key of PAID_PLAN_KEYS) {
      expect(PLANS[key].priceUsd).toBeGreaterThan(0);
      expect(PLANS[key].monthlyCredits).toBeGreaterThan(0);
    }
  });

  it("plan keys are self-consistent (they double as Stripe lookup keys)", () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.key).toBe(key);
    }
  });

  it("the trial is not purchasable", () => {
    expect(isPaidPlanKey("free_trial")).toBe(false);
    expect(isPaidPlanKey("starter")).toBe(true);
    expect(isPaidPlanKey("nonsense")).toBe(false);
    expect(PLANS.free_trial.priceUsd).toBe(0);
    expect(PLANS.free_trial.monthlyCredits).toBe(TRIAL_CREDITS);
  });

  it("higher tiers grant strictly more credits", () => {
    expect(PLANS.starter.monthlyCredits).toBeGreaterThan(TRIAL_CREDITS);
    expect(PLANS.pro.monthlyCredits).toBeGreaterThan(PLANS.starter.monthlyCredits);
    expect(PLANS.power.monthlyCredits).toBeGreaterThan(PLANS.pro.monthlyCredits);
  });

  it("an AI extraction costs exactly one credit in v1", () => {
    expect(CREDIT_COST_AI_EXTRACTION).toBe(1);
  });
});

describe("subscription field extraction (Stripe API-version drift)", () => {
  it("reads period from the subscription root (older API shapes)", () => {
    const period = subscriptionPeriod({
      id: "sub_1",
      status: "active",
      customer: "cus_1",
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
    });
    expect(period.start).toBe(1_700_000_000);
    expect(period.end).toBe(1_702_592_000);
  });

  it("falls back to the first item (newer API shapes)", () => {
    const period = subscriptionPeriod({
      id: "sub_2",
      status: "active",
      customer: "cus_1",
      items: {
        data: [
          { current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 },
        ],
      },
    });
    expect(period.start).toBe(1_700_000_000);
    expect(period.end).toBe(1_702_592_000);
  });

  it("prefers subscription metadata for the plan key, then price lookup_key", () => {
    expect(
      subscriptionPlanKey({
        id: "sub_3",
        status: "active",
        customer: "cus_1",
        metadata: { plan_key: "pro" },
        items: { data: [{ price: { lookup_key: "starter" } }] },
      })
    ).toBe("pro");

    expect(
      subscriptionPlanKey({
        id: "sub_4",
        status: "active",
        customer: "cus_1",
        items: { data: [{ price: { lookup_key: "starter" } }] },
      })
    ).toBe("starter");

    expect(
      subscriptionPlanKey({ id: "sub_5", status: "active", customer: "cus_1" })
    ).toBeNull();
  });

  it("converts unix seconds to ISO strings and passes null through", () => {
    expect(unixToIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(unixToIso(null)).toBeNull();
  });
});
