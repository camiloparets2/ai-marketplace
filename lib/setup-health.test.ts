// lib/setup-health — the bucket-visibility assertion. A private
// listing-photos bucket is the root cause behind dead photo URLs (Part 3),
// so the check must name it precisely.

import { describe, it, expect, vi, beforeEach } from "vitest";

const getBucket = vi.fn();
vi.mock("@/lib/connections", () => ({
  getSupabaseAdmin: () => ({ storage: { getBucket } }),
}));

import { checkListingPhotoBucket, runSetupChecks } from "./setup-health";

beforeEach(() => {
  getBucket.mockReset();
});

describe("checkListingPhotoBucket", () => {
  it("passes when the bucket exists and is public", async () => {
    getBucket.mockResolvedValue({
      data: { id: "listing-photos", public: true },
      error: null,
    });
    const check = await checkListingPhotoBucket();
    expect(check.ok).toBe(true);
    expect(getBucket).toHaveBeenCalledWith("listing-photos");
  });

  it("fails a PRIVATE bucket and says exactly what to flip", async () => {
    // The live production misconfiguration.
    getBucket.mockResolvedValue({
      data: { id: "listing-photos", public: false },
      error: null,
    });
    const check = await checkListingPhotoBucket();
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/PRIVATE/);
    expect(check.detail).toMatch(/public in Supabase Storage/i);
  });

  it("fails a missing bucket without throwing", async () => {
    getBucket.mockResolvedValue({
      data: null,
      error: { message: "Bucket not found" },
    });
    const check = await checkListingPhotoBucket();
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/not found/i);
  });

  it("reports (not throws) infrastructure errors", async () => {
    getBucket.mockRejectedValue(new Error("supabase down"));
    const check = await checkListingPhotoBucket();
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/supabase down/);
  });
});

describe("runSetupChecks", () => {
  it("includes the bucket assertion", async () => {
    getBucket.mockResolvedValue({
      data: { id: "listing-photos", public: true },
      error: null,
    });
    const checks = await runSetupChecks();
    expect(checks.map((c) => c.name)).toContain("listing_photo_bucket_public");
  });
});
