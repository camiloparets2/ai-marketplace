import { describe, it, expect } from "vitest";
import { routeChannels, etsyEligibility } from "./routing";

const NOW = new Date("2026-07-07T00:00:00Z");

const base = { handmade: false, estimatedYearMade: null, craftSupply: false };

describe("routeChannels — the Etsy exclusion rule", () => {
  it("routes ordinary mass-produced items to eBay only", () => {
    const d = routeChannels(base, NOW);
    expect(d.channels).toEqual(["ebay"]);
    expect(d.etsyEligible).toBe(false);
    expect(d.rationale).toContain("Etsy skipped");
  });

  it("adds Etsy for genuinely handmade items", () => {
    const d = routeChannels({ ...base, handmade: true }, NOW);
    expect(d.channels).toEqual(["ebay", "etsy"]);
    expect(d.etsyBasis).toBe("handmade");
  });

  it("adds Etsy for craft supplies", () => {
    const d = routeChannels({ ...base, craftSupply: true }, NOW);
    expect(d.channels).toEqual(["ebay", "etsy"]);
    expect(d.etsyBasis).toBe("craft_supply");
  });

  it("adds Etsy for vintage exactly at and past 20 years, never under", () => {
    expect(
      routeChannels({ ...base, estimatedYearMade: 2006 }, NOW).etsyEligible
    ).toBe(true);
    expect(
      routeChannels({ ...base, estimatedYearMade: 1985 }, NOW).etsyBasis
    ).toBe("vintage");
    // 19 years old — modern, not vintage
    expect(
      routeChannels({ ...base, estimatedYearMade: 2007 }, NOW).etsyEligible
    ).toBe(false);
  });

  it("eBay is always in the route, whatever else qualifies", () => {
    for (const extraction of [
      base,
      { ...base, handmade: true },
      { ...base, estimatedYearMade: 1970 },
      { handmade: true, craftSupply: true, estimatedYearMade: 1970 },
    ]) {
      expect(routeChannels(extraction, NOW).channels[0]).toBe("ebay");
    }
  });
});

describe("etsyEligibility precedence", () => {
  it("reports handmade before vintage when both apply", () => {
    expect(
      etsyEligibility({ ...base, handmade: true, estimatedYearMade: 1980 }, NOW)
        .basis
    ).toBe("handmade");
  });
});
