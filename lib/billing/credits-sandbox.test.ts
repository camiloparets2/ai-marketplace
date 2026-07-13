// Sandbox credit bypass (live incident: sandbox and production share one
// Supabase project, so testing the sandbox build consumed REAL customer
// quota from monthly_credit_grants until the grant hit zero).
//
// Property: with EBAY_ENV=sandbox (or the explicit dev flag) the credit
// layer neither enforces nor decrements — it never touches the DB at all.
// The mocked getSupabaseAdmin THROWS, so any billing-table access fails
// the test by construction.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/connections", () => ({
  getSupabaseAdmin: vi.fn(() => {
    throw new Error("billing table touched — the bypass must not reach the DB");
  }),
}));

import {
  spendCredits,
  refundCredits,
  getCreditStatus,
  ensureTrialGrant,
  BYPASS_CREDITS_REMAINING,
} from "./credits";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sandbox credit bypass", () => {
  it("EBAY_ENV=sandbox: spend succeeds without touching monthly_credit_grants", async () => {
    vi.stubEnv("EBAY_ENV", "sandbox");
    const result = await spendCredits("user-1", 1, "ai_extraction", "req-1");
    expect(result).toEqual({ ok: true, remaining: BYPASS_CREDITS_REMAINING });
  });

  it("EBAY_ENV=sandbox: refund, status, and trial grant are DB no-ops", async () => {
    vi.stubEnv("EBAY_ENV", "sandbox");
    await expect(refundCredits("user-1", 1, "req-1")).resolves.toBeUndefined();
    await expect(ensureTrialGrant("user-1")).resolves.toBeUndefined();
    const status = await getCreditStatus("user-1");
    expect(status).toMatchObject({
      creditsRemaining: BYPASS_CREDITS_REMAINING,
      hasEverHadGrant: true,
    });
  });

  it("DISABLE_CREDIT_ENFORCEMENT=true bypasses outside sandbox too", async () => {
    vi.stubEnv("DISABLE_CREDIT_ENFORCEMENT", "true");
    const result = await spendCredits("user-1", 1, "ai_extraction", "req-2");
    expect(result).toEqual({ ok: true, remaining: BYPASS_CREDITS_REMAINING });
  });

  it("production still fails CLOSED when billing is unreachable — no unmetered path", async () => {
    // No sandbox env, no dev flag: the throwing DB must surface as
    // 'unavailable' (callers 503), never as a free pass.
    const result = await spendCredits("user-1", 1, "ai_extraction", "req-3");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
