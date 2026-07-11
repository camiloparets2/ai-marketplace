import { describe, it, expect } from "vitest";
import {
  marketplaceForCountry,
  marketplaceById,
  DEFAULT_EBAY_MARKETPLACE,
} from "./ebay-marketplaces";

describe("marketplaceForCountry", () => {
  it("maps major seller countries to their marketplace and currency", () => {
    expect(marketplaceForCountry("US")).toMatchObject({
      id: "EBAY_US",
      currency: "USD",
      categoryTreeId: "0",
    });
    expect(marketplaceForCountry("GB")).toMatchObject({
      id: "EBAY_GB",
      currency: "GBP",
      categoryTreeId: "3",
      contentLanguage: "en-GB",
    });
    expect(marketplaceForCountry("DE")).toMatchObject({
      id: "EBAY_DE",
      currency: "EUR",
      contentLanguage: "de-DE",
    });
    expect(marketplaceForCountry("AU")).toMatchObject({
      id: "EBAY_AU",
      currency: "AUD",
    });
    expect(marketplaceForCountry("CA")).toMatchObject({
      id: "EBAY_CA",
      currency: "CAD",
    });
  });

  it("is case-insensitive", () => {
    expect(marketplaceForCountry("gb").id).toBe("EBAY_GB");
  });

  it("falls back to EBAY_US for countries without their own marketplace", () => {
    expect(marketplaceForCountry("BR")).toBe(DEFAULT_EBAY_MARKETPLACE);
    expect(marketplaceForCountry("JP")).toBe(DEFAULT_EBAY_MARKETPLACE);
    expect(marketplaceForCountry(null)).toBe(DEFAULT_EBAY_MARKETPLACE);
    expect(marketplaceForCountry(undefined)).toBe(DEFAULT_EBAY_MARKETPLACE);
  });
});

describe("marketplaceById", () => {
  it("round-trips every id derivable from a country", () => {
    for (const country of ["US", "GB", "DE", "AU", "CA", "FR", "PL"]) {
      const m = marketplaceForCountry(country);
      expect(marketplaceById(m.id)).toEqual(m);
    }
  });

  it("returns null for unknown or missing ids", () => {
    expect(marketplaceById("EBAY_MOON")).toBeNull();
    expect(marketplaceById(null)).toBeNull();
    expect(marketplaceById(undefined)).toBeNull();
  });
});
