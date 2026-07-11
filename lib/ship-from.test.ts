import { describe, it, expect } from "vitest";
import {
  validateShipFrom,
  countryUsesPostalCodes,
  ISO_COUNTRY_CODES,
  NO_POSTAL_CODE_COUNTRIES,
} from "./ship-from";

describe("validateShipFrom", () => {
  it("accepts a US ZIP", () => {
    const v = validateShipFrom({ country: "US", postalCode: "94103" });
    expect(v.ok).toBe(true);
    expect(v.value).toEqual({
      country: "US",
      postalCode: "94103",
      city: null,
      stateOrProvince: null,
    });
  });

  it("accepts non-US postal formats: GB, DE, AU, CA, NL", () => {
    // GB codes are alphanumeric with a space; NL mixes digits and letters —
    // no 5-digit-ZIP assumption anywhere.
    for (const [country, postalCode] of [
      ["GB", "SW1A 1AA"],
      ["DE", "10115"],
      ["AU", "2000"],
      ["CA", "K1A 0B1"],
      ["NL", "1012 AB"],
    ] as const) {
      const v = validateShipFrom({ country, postalCode });
      expect(v.ok, `${country} ${postalCode}`).toBe(true);
      expect(v.value.country).toBe(country);
      expect(v.value.postalCode).toBe(postalCode);
    }
  });

  it("normalises lowercase country and trims fields", () => {
    const v = validateShipFrom({ country: " gb ", postalCode: " SW1A 1AA " });
    expect(v.ok).toBe(true);
    expect(v.value.country).toBe("GB");
    expect(v.value.postalCode).toBe("SW1A 1AA");
  });

  it("requires a postal code where the country uses them", () => {
    const v = validateShipFrom({ country: "DE" });
    expect(v.ok).toBe(false);
    expect(v.errors.postalCode).toBeTruthy();
  });

  it("accepts a postal-free country with city + state instead", () => {
    // Hong Kong has no postal codes; eBay accepts city+stateOrProvince+country.
    const v = validateShipFrom({
      country: "HK",
      city: "Hong Kong",
      stateOrProvince: "Hong Kong Island",
    });
    expect(v.ok).toBe(true);
    expect(v.value.postalCode).toBeNull();
    expect(v.value.city).toBe("Hong Kong");
  });

  it("requires city and state when a postal-free country omits both", () => {
    const v = validateShipFrom({ country: "AE" });
    expect(v.ok).toBe(false);
    expect(v.errors.city).toBeTruthy();
    expect(v.errors.stateOrProvince).toBeTruthy();
  });

  it("still accepts a postal code from a postal-free country", () => {
    // The no-postal list is advisory — a seller who has one may use it.
    const v = validateShipFrom({ country: "AE", postalCode: "00000" });
    expect(v.ok).toBe(true);
  });

  it("rejects unknown or malformed countries", () => {
    for (const country of ["XX", "USA", "U", "", undefined]) {
      const v = validateShipFrom({ country, postalCode: "94103" });
      expect(v.ok, String(country)).toBe(false);
      expect(v.errors.country).toBeTruthy();
    }
  });

  it("rejects postal codes with characters eBay can't take", () => {
    const v = validateShipFrom({ country: "US", postalCode: "941<script>" });
    expect(v.ok).toBe(false);
    expect(v.errors.postalCode).toBeTruthy();
  });
});

describe("countryUsesPostalCodes", () => {
  it("is true for postal countries and false for the no-postal set", () => {
    expect(countryUsesPostalCodes("US")).toBe(true);
    expect(countryUsesPostalCodes("gb")).toBe(true);
    expect(countryUsesPostalCodes("HK")).toBe(false);
    expect(countryUsesPostalCodes("ae")).toBe(false);
  });
});

describe("country data", () => {
  it("every no-postal country except legacy codes is a real ISO code", () => {
    // AN (Netherlands Antilles) is kept for sellers with legacy addresses.
    for (const code of NO_POSTAL_CODE_COUNTRIES) {
      if (code === "AN") continue;
      expect(ISO_COUNTRY_CODES.has(code), code).toBe(true);
    }
  });
});
