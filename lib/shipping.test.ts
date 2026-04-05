import { describe, it, expect } from "vitest";
import { getShippingRate, getAllFlatRates } from "@/lib/shipping";
import { SHIPPING_DISPLAY_NAMES } from "@/lib/types/extraction";

describe("getShippingRate", () => {
  it("returns $10.40 for USPS_FLAT_RATE_SMALL", () => {
    const rate = getShippingRate("USPS_FLAT_RATE_SMALL");
    expect(rate.cost).toBe(10.4);
    expect(rate.service).toBe("USPS_FLAT_RATE_SMALL");
    expect(rate.displayName).toBe(
      SHIPPING_DISPLAY_NAMES.USPS_FLAT_RATE_SMALL
    );
  });

  it("returns $16.10 for USPS_FLAT_RATE_MEDIUM", () => {
    const rate = getShippingRate("USPS_FLAT_RATE_MEDIUM");
    expect(rate.cost).toBe(16.1);
    expect(rate.service).toBe("USPS_FLAT_RATE_MEDIUM");
    expect(rate.displayName).toBe(
      SHIPPING_DISPLAY_NAMES.USPS_FLAT_RATE_MEDIUM
    );
  });

  it("returns $22.45 for USPS_FLAT_RATE_LARGE", () => {
    const rate = getShippingRate("USPS_FLAT_RATE_LARGE");
    expect(rate.cost).toBe(22.45);
    expect(rate.service).toBe("USPS_FLAT_RATE_LARGE");
    expect(rate.displayName).toBe(
      SHIPPING_DISPLAY_NAMES.USPS_FLAT_RATE_LARGE
    );
  });

  it("returns null cost for MANUAL_ESTIMATE_NEEDED", () => {
    const rate = getShippingRate("MANUAL_ESTIMATE_NEEDED");
    expect(rate.cost).toBeNull();
    expect(rate.service).toBe("MANUAL_ESTIMATE_NEEDED");
    expect(rate.displayName).toBe(
      SHIPPING_DISPLAY_NAMES.MANUAL_ESTIMATE_NEEDED
    );
  });
});

describe("getAllFlatRates", () => {
  it("returns exactly 3 flat rate options (excludes MANUAL_ESTIMATE_NEEDED)", () => {
    const rates = getAllFlatRates();
    expect(rates).toHaveLength(3);
    const services = rates.map((r) => r.service);
    expect(services).toContain("USPS_FLAT_RATE_SMALL");
    expect(services).toContain("USPS_FLAT_RATE_MEDIUM");
    expect(services).toContain("USPS_FLAT_RATE_LARGE");
    expect(services).not.toContain("MANUAL_ESTIMATE_NEEDED");
  });

  it("all returned rates have a non-null cost", () => {
    const rates = getAllFlatRates();
    for (const rate of rates) {
      expect(rate.cost).not.toBeNull();
      expect(typeof rate.cost).toBe("number");
    }
  });

  it("rates are sorted cheapest to most expensive", () => {
    const rates = getAllFlatRates();
    const costs = rates.map((r) => r.cost as number);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });
});
