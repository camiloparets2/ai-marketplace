// Default fulfillment-policy creation (eBay Sandbox bug: "Please select a
// valid shipping service", errorId 20403).
//
// Root cause: a buyer-paid (freeShipping:false) DOMESTIC FLAT_RATE service
// with NO shippingCost is rejected by eBay — the error text names the
// "shipping service" but the missing field is the cost. Fix: always send a
// positive baseline shippingCost, and never hardcode one service code —
// try vetted codes in order, degrading to handling-time-only if none stick.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildDefaultFulfillmentPolicy,
  createFulfillmentPolicy,
  DEFAULT_FULFILLMENT_POLICY_NAME,
  EbaySellerSetupError,
} from "./ebay";
import {
  marketplaceForCountry,
  domesticShippingCandidates,
} from "./ebay-marketplaces";

const US = marketplaceForCountry("US");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Payload shape (the actual fix) ────────────────────────────────────────────

describe("buildDefaultFulfillmentPolicy", () => {
  it("sends a POSITIVE buyer-paid shippingCost on the flat-rate service", () => {
    const p = buildDefaultFulfillmentPolicy(US);
    const svc = p.shippingOptions?.[0].shippingServices[0];
    expect(svc?.freeShipping).toBe(false); // money rule: never silently free
    expect(svc?.shippingServiceCode).toBe("USPSGroundAdvantage");
    // The missing field that caused 20403 — present, positive, right currency.
    expect(svc?.shippingCost).toBeDefined();
    expect(Number(svc?.shippingCost?.value)).toBeGreaterThan(0);
    expect(svc?.shippingCost?.currency).toBe("USD");
  });

  it("uses a specific candidate service when told to (fallback retries)", () => {
    const p = buildDefaultFulfillmentPolicy(US, {
      carrierCode: "USPS",
      serviceCode: "USPSPriority",
    });
    expect(p.shippingOptions?.[0].shippingServices[0].shippingServiceCode).toBe(
      "USPSPriority"
    );
    expect(
      p.shippingOptions?.[0].shippingServices[0].shippingCost
    ).toBeDefined();
  });

  it("degrades to handling-time-only (no shippingOptions) when service is null", () => {
    const p = buildDefaultFulfillmentPolicy(US, null);
    expect(p.shippingOptions).toBeUndefined();
    expect(p.handlingTime).toEqual({ value: 3, unit: "DAY" });
  });
});

describe("domesticShippingCandidates", () => {
  it("orders primary first, then fallbacks, de-duplicated", () => {
    expect(domesticShippingCandidates(US).map((s) => s.serviceCode)).toEqual([
      "USPSGroundAdvantage",
      "USPSPriority",
      "USPSParcel",
    ]);
  });

  it("is empty for a marketplace with no vetted service", () => {
    expect(domesticShippingCandidates(marketplaceForCountry("FR"))).toEqual([]);
  });
});

// ── Creation: fetch-stubbed, no network ───────────────────────────────────────

interface Call {
  method: string;
  serviceCode: string | null;
}

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
function fail(status: number, longMessage: string): Response {
  const body = { errors: [{ longMessage }] };
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Stub POST /fulfillment_policy with a scripted list of responses (in order),
// and GET (listFirstPolicy) with a fixed response. Records the service code
// sent on each POST so tests can assert the fallback order.
function stub(
  postResponses: Response[],
  listResponse: Response = ok({ fulfillmentPolicies: [] })
): Call[] {
  const calls: Call[] = [];
  let postIdx = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({
          method,
          serviceCode:
            body.shippingOptions?.[0]?.shippingServices?.[0]?.shippingServiceCode ??
            null,
        });
        return postResponses[postIdx++] ?? fail(500, "unexpected extra POST");
      }
      calls.push({ method, serviceCode: null });
      return listResponse;
    })
  );
  return calls;
}

describe("createFulfillmentPolicy", () => {
  it("uses the primary service and stops when eBay accepts it", async () => {
    const calls = stub([ok({ fulfillmentPolicyId: "f-1" })]);
    const result = await createFulfillmentPolicy("tok", US);
    expect(result).toEqual({ id: "f-1", appDefault: true });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].serviceCode).toBe("USPSGroundAdvantage");
  });

  it("retries the NEXT vetted code when eBay rejects the first (20403)", async () => {
    const calls = stub([
      fail(400, "Please select a valid shipping service."),
      ok({ fulfillmentPolicyId: "f-2" }),
    ]);
    const result = await createFulfillmentPolicy("tok", US);
    expect(result).toEqual({ id: "f-2", appDefault: true });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => p.serviceCode)).toEqual([
      "USPSGroundAdvantage",
      "USPSPriority",
    ]);
  });

  it("degrades to a handling-time-only policy when NO service is accepted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Reject all three vetted codes, accept the final null (handling-only).
    const calls = stub([
      fail(400, "Please select a valid shipping service."),
      fail(400, "Please select a valid shipping service."),
      fail(400, "Please select a valid shipping service."),
      ok({ fulfillmentPolicyId: "f-degraded" }),
    ]);
    const result = await createFulfillmentPolicy("tok", US);
    expect(result).toEqual({ id: "f-degraded", appDefault: true });
    const posts = calls.filter((c) => c.method === "POST");
    // 3 vetted codes + the handling-time-only (no service) attempt.
    expect(posts.map((p) => p.serviceCode)).toEqual([
      "USPSGroundAdvantage",
      "USPSPriority",
      "USPSParcel",
      null,
    ]);
    expect(warn).toHaveBeenCalled();
  });

  it("throws the seller-setup error when eBay says the account is not eligible", async () => {
    stub([fail(400, "User is not eligible for Business Policy.")]);
    await expect(createFulfillmentPolicy("tok", US)).rejects.toBeInstanceOf(
      EbaySellerSetupError
    );
  });

  it("adopts an existing policy on a non-retryable error (duplicate-name race)", async () => {
    const calls = stub(
      [fail(400, "A policy with this name already exists")],
      ok({
        fulfillmentPolicies: [
          { fulfillmentPolicyId: "f-existing", name: DEFAULT_FULFILLMENT_POLICY_NAME },
        ],
      })
    );
    const result = await createFulfillmentPolicy("tok", US);
    expect(result).toEqual({ id: "f-existing", appDefault: true });
    // One POST (rejected), then the adopt GET — no blind retry of codes.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.some((c) => c.method === "GET")).toBe(true);
  });
});
