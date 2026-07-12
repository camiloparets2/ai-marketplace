// ensureEbayPolicies / detectEbayReadiness — the seller-readiness ensure
// chain (docs/design/ebay-seller-readiness.md): env → meta cache → detect →
// remediate (opt-in / create defaults) → cache, with the three unfixable-vs-
// fixable states surfaced as typed errors. All eBay calls mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PlatformConnection } from "./types";

vi.mock("@/lib/connections", () => ({
  saveConnection: vi.fn(async () => undefined),
  isExpired: () => false,
}));
vi.mock("@/lib/locations", () => ({
  getShipFromLocation: vi.fn(async () => null),
}));

import { saveConnection } from "@/lib/connections";
import {
  ensureEbayPolicies,
  detectEbayReadiness,
  EbaySellerSetupError,
  buildDefaultFulfillmentPolicy,
  buildDefaultPaymentPolicy,
  buildDefaultReturnPolicy,
} from "./ebay";
import { marketplaceForCountry } from "./ebay-marketplaces";

const conn = (meta: Record<string, string> = {}): PlatformConnection => ({
  userId: "user-1",
  platform: "ebay",
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  meta,
});

const NOT_ELIGIBLE_BODY = {
  errors: [{ message: "User is not eligible for Business Policy." }],
};

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204 || status === 205) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
  contentLanguage: string | null;
}

let calls: RecordedCall[];

function stubEbayApi(
  handler: (path: string, method: string) => Response
): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        path,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        contentLanguage: headers["Content-Language"] ?? null,
      });
      return handler(path, method);
    })
  );
}

// A seller with the program active and existing policies for every kind.
function readySellerHandler(path: string): Response {
  if (path.includes("get_opted_in_programs")) {
    return jsonResponse(200, {
      programs: [{ programType: "SELLING_POLICY_MANAGEMENT" }],
    });
  }
  if (path.startsWith("/sell/account/v1/fulfillment_policy")) {
    return jsonResponse(200, {
      fulfillmentPolicies: [{ fulfillmentPolicyId: "f-existing" }],
    });
  }
  if (path.startsWith("/sell/account/v1/payment_policy")) {
    return jsonResponse(200, {
      paymentPolicies: [{ paymentPolicyId: "p-existing" }],
    });
  }
  if (path.startsWith("/sell/account/v1/return_policy")) {
    return jsonResponse(200, {
      returnPolicies: [{ returnPolicyId: "r-existing" }],
    });
  }
  return jsonResponse(500, {});
}

// A brand-new (but registered) seller: not opted in, owns nothing yet;
// opt-in and every create succeed.
function newSellerHandler(path: string, method: string): Response {
  if (path.includes("get_opted_in_programs")) {
    return jsonResponse(200, { programs: [] });
  }
  if (path.includes("/program/opt_in")) {
    return jsonResponse(200, {});
  }
  if (method === "GET" && path.includes("_policy?")) {
    return jsonResponse(200, {});
  }
  if (method === "POST" && path.endsWith("/fulfillment_policy")) {
    return jsonResponse(201, { fulfillmentPolicyId: "f-new" });
  }
  if (method === "POST" && path.endsWith("/payment_policy")) {
    return jsonResponse(201, { paymentPolicyId: "p-new" });
  }
  if (method === "POST" && path.endsWith("/return_policy")) {
    return jsonResponse(201, { returnPolicyId: "r-new" });
  }
  return jsonResponse(500, {});
}

beforeEach(() => {
  vi.mocked(saveConnection).mockClear();
  delete process.env.EBAY_FULFILLMENT_POLICY_ID;
  delete process.env.EBAY_PAYMENT_POLICY_ID;
  delete process.env.EBAY_RETURN_POLICY_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureEbayPolicies", () => {
  it("reuses cached meta ids with zero eBay calls", async () => {
    stubEbayApi(() => jsonResponse(500, {}));
    const ids = await ensureEbayPolicies(
      conn({
        fulfillmentPolicyId: "f-cached",
        paymentPolicyId: "p-cached",
        returnPolicyId: "r-cached",
      }),
      marketplaceForCountry("US")
    );
    expect(ids).toEqual({
      fulfillmentPolicyId: "f-cached",
      paymentPolicyId: "p-cached",
      returnPolicyId: "r-cached",
    });
    expect(calls).toHaveLength(0);
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("detects existing policies (opted in) and caches them without creating", async () => {
    stubEbayApi(readySellerHandler);
    const c = conn();
    const ids = await ensureEbayPolicies(c, marketplaceForCountry("US"));
    expect(ids).toEqual({
      fulfillmentPolicyId: "f-existing",
      paymentPolicyId: "p-existing",
      returnPolicyId: "r-existing",
    });
    expect(calls.filter((c2) => c2.method === "POST")).toHaveLength(0);
    // Cached for the next publish (mutated in memory + persisted).
    expect(c.meta).toMatchObject(ids);
    expect(saveConnection).toHaveBeenCalledOnce();
  });

  it("opts a registered-but-not-opted-in seller in, then creates all three defaults", async () => {
    stubEbayApi(newSellerHandler);
    const c = conn();
    const ids = await ensureEbayPolicies(c, marketplaceForCountry("US"));
    expect(ids).toEqual({
      fulfillmentPolicyId: "f-new",
      paymentPolicyId: "p-new",
      returnPolicyId: "r-new",
    });

    // Opt-in fired, and BEFORE any policy creation.
    const optInIdx = calls.findIndex((c2) => c2.path.includes("/program/opt_in"));
    const firstCreateIdx = calls.findIndex(
      (c2) => c2.method === "POST" && c2.path.includes("_policy")
    );
    expect(optInIdx).toBeGreaterThanOrEqual(0);
    expect(calls[optInIdx].body).toEqual({
      programType: "SELLING_POLICY_MANAGEMENT",
    });
    expect(firstCreateIdx).toBeGreaterThan(optInIdx);

    // Conservative defaults, cached for the next publish.
    const fulfillment = calls.find(
      (c2) => c2.method === "POST" && c2.path.endsWith("/fulfillment_policy")
    );
    expect(fulfillment?.body).toMatchObject({
      marketplaceId: "EBAY_US",
      handlingTime: { value: 3, unit: "DAY" },
    });
    const returns = calls.find(
      (c2) => c2.method === "POST" && c2.path.endsWith("/return_policy")
    );
    expect(returns?.body).toMatchObject({
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: "DAY" },
      returnShippingCostPayer: "BUYER",
    });
    expect(c.meta).toMatchObject(ids);
  });

  it("creates policies against the seller's marketplace — GB, DE, AU — never EBAY_US", async () => {
    for (const [country, marketplaceId, serviceCode] of [
      ["GB", "EBAY_GB", "UK_RoyalMailSecondClassStandard"],
      ["DE", "EBAY_DE", "DE_DHLPaket"],
      ["AU", "EBAY_AU", "AU_Regular"],
    ] as const) {
      stubEbayApi(newSellerHandler);
      await ensureEbayPolicies(conn(), marketplaceForCountry(country));

      const creates = calls.filter((c2) => c2.method === "POST" && c2.path.includes("_policy"));
      expect(creates, country).toHaveLength(3);
      for (const create of creates) {
        expect((create.body as { marketplaceId: string }).marketplaceId, country).toBe(marketplaceId);
      }
      const fulfillment = creates.find((c2) => c2.path.endsWith("/fulfillment_policy"));
      const body = fulfillment?.body as {
        shippingOptions?: Array<{ shippingServices: Array<{ shippingServiceCode: string }> }>;
      };
      expect(body.shippingOptions?.[0]?.shippingServices[0]?.shippingServiceCode, country).toBe(serviceCode);
      // Content-Language must match the marketplace, not en-US.
      expect(fulfillment?.contentLanguage, country).toBe(
        marketplaceForCountry(country).contentLanguage
      );
    }
  });

  it("maps 'not eligible for Business Policy' to the typed not_registered error — never a raw 400", async () => {
    stubEbayApi(() => jsonResponse(400, NOT_ELIGIBLE_BODY));
    const err = await ensureEbayPolicies(
      conn(),
      marketplaceForCountry("US")
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EbaySellerSetupError);
    expect((err as EbaySellerSetupError).kind).toBe("not_registered");
    // End-user safe: no status code, no eBay API jargon; actionable language.
    expect((err as Error).message).not.toMatch(/400|Business Policy lookup/);
    expect((err as Error).message).toMatch(/seller registration/i);
  });

  it("maps not-eligible RIGHT AFTER a successful opt-in to policies_pending, not not_registered", async () => {
    stubEbayApi((path) => {
      if (path.includes("get_opted_in_programs")) {
        return jsonResponse(200, { programs: [] });
      }
      if (path.includes("/program/opt_in")) return jsonResponse(200, {});
      // Program still activating — eBay briefly keeps reporting ineligible.
      return jsonResponse(400, NOT_ELIGIBLE_BODY);
    });
    const err = await ensureEbayPolicies(
      conn(),
      marketplaceForCountry("US")
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EbaySellerSetupError);
    expect((err as EbaySellerSetupError).kind).toBe("policies_pending");
    expect((err as Error).message).toMatch(/few minutes|shortly/i);
  });

  it("adopts the existing policy on a duplicate-name create race", async () => {
    let created = false;
    stubEbayApi((path, method) => {
      if (path.includes("get_opted_in_programs")) {
        return jsonResponse(200, {
          programs: [{ programType: "SELLING_POLICY_MANAGEMENT" }],
        });
      }
      if (method === "GET" && path.startsWith("/sell/account/v1/fulfillment_policy")) {
        // Empty on the first probe; present after the losing create re-lists.
        return created
          ? jsonResponse(200, { fulfillmentPolicies: [{ fulfillmentPolicyId: "f-race" }] })
          : jsonResponse(200, {});
      }
      if (method === "POST" && path.endsWith("/fulfillment_policy")) {
        created = true;
        return jsonResponse(400, {
          errors: [{ message: "A policy with this name already exists." }],
        });
      }
      if (method === "GET" && path.includes("_policy?")) {
        return path.includes("payment")
          ? jsonResponse(200, { paymentPolicies: [{ paymentPolicyId: "p1" }] })
          : jsonResponse(200, { returnPolicies: [{ returnPolicyId: "r1" }] });
      }
      return jsonResponse(500, {});
    });
    const ids = await ensureEbayPolicies(conn(), marketplaceForCountry("US"));
    expect(ids.fulfillmentPolicyId).toBe("f-race");
  });

  it("lets env overrides win without caching them into meta", async () => {
    process.env.EBAY_FULFILLMENT_POLICY_ID = "f-env";
    process.env.EBAY_PAYMENT_POLICY_ID = "p-env";
    process.env.EBAY_RETURN_POLICY_ID = "r-env";
    stubEbayApi(() => jsonResponse(500, {}));
    const ids = await ensureEbayPolicies(conn(), marketplaceForCountry("US"));
    expect(ids).toEqual({
      fulfillmentPolicyId: "f-env",
      paymentPolicyId: "p-env",
      returnPolicyId: "r-env",
    });
    expect(calls).toHaveLength(0);
    expect(saveConnection).not.toHaveBeenCalled();
  });
});

describe("detectEbayReadiness (detect-only, for the channels checklist)", () => {
  it("reports ready from meta without probing policies", async () => {
    stubEbayApi(() => jsonResponse(500, {}));
    const readiness = await detectEbayReadiness(
      conn({
        merchantLocationKey: "loc-1",
        marketplaceId: "EBAY_GB",
        fulfillmentPolicyId: "f1",
        paymentPolicyId: "p1",
        returnPolicyId: "r1",
      })
    );
    expect(readiness).toEqual({ shipFrom: true, policies: "ready" });
    expect(calls).toHaveLength(0);
  });

  it("reports missing (fixable) when not opted in — and never mutates eBay", async () => {
    stubEbayApi((path) => {
      if (path.startsWith("/sell/inventory/v1/location?")) {
        return jsonResponse(200, { locations: [] });
      }
      if (path.includes("get_opted_in_programs")) {
        return jsonResponse(200, { programs: [] });
      }
      return jsonResponse(500, {});
    });
    const readiness = await detectEbayReadiness(conn());
    expect(readiness).toEqual({ shipFrom: false, policies: "missing" });
    // Detect-only: a channels page view must not opt in or create anything.
    expect(calls.filter((c2) => c2.method !== "GET")).toHaveLength(0);
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("reports not_registered for the seller-registration CTA", async () => {
    stubEbayApi((path) =>
      path.startsWith("/sell/inventory/v1/location?")
        ? jsonResponse(200, { locations: [] })
        : jsonResponse(400, NOT_ELIGIBLE_BODY)
    );
    const readiness = await detectEbayReadiness(conn());
    expect(readiness.policies).toBe("not_registered");
  });

  it("reports unknown on infra errors instead of blocking the page", async () => {
    stubEbayApi(() => jsonResponse(503, { errors: [{ message: "down" }] }));
    const readiness = await detectEbayReadiness(conn({ merchantLocationKey: "loc-1" }));
    expect(readiness).toEqual({ shipFrom: true, policies: "unknown" });
  });
});

describe("default policy builders", () => {
  it("builds marketplace-correct conservative defaults", () => {
    const gb = marketplaceForCountry("GB");
    expect(buildDefaultFulfillmentPolicy(gb)).toMatchObject({
      marketplaceId: "EBAY_GB",
      handlingTime: { value: 3, unit: "DAY" },
      shippingOptions: [
        {
          optionType: "DOMESTIC",
          costType: "FLAT_RATE",
          shippingServices: [
            {
              shippingCarrierCode: "RoyalMail",
              shippingServiceCode: "UK_RoyalMailSecondClassStandard",
              freeShipping: true,
            },
          ],
        },
      ],
    });
    expect(buildDefaultPaymentPolicy(gb)).toMatchObject({
      marketplaceId: "EBAY_GB",
      immediatePay: true,
    });
    expect(buildDefaultReturnPolicy(gb)).toMatchObject({
      marketplaceId: "EBAY_GB",
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: "DAY" },
      returnShippingCostPayer: "BUYER",
      refundMethod: "MONEY_BACK",
    });
  });

  it("omits shippingOptions for marketplaces without a vetted service code", () => {
    // PL has no vetted default carrier yet — handling time only; the
    // checklist tells the seller to pick a service on eBay.
    const policy = buildDefaultFulfillmentPolicy(marketplaceForCountry("PL"));
    expect(policy.marketplaceId).toBe("EBAY_PL");
    expect("shippingOptions" in policy).toBe(false);
  });
});
