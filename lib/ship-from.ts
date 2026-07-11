// Ship-from location: types + validation (docs/design/ship-from-location.md).
//
// Pure and dependency-free so both the settings form (browser) and the API
// routes (server) validate with the SAME rules — persistence lives in
// lib/locations.ts, eBay location creation in lib/platforms/ebay.ts.
//
// Global correctness rules (no US assumptions):
//   * country: ISO 3166-1 alpha-2, required, must be a real assigned code.
//   * postal code: required only where the country uses postal codes; format
//     is NOT validated per-country (GB "SW1A 1AA", DE "10115", IE "D02 AF30"
//     are all fine) — eBay is the final validator.
//   * city + state/province: required when the country has no postal codes,
//     because eBay accepts an address as either country+postalCode or
//     country+city+stateOrProvince.

export interface ShipFromLocation {
  // ISO 3166-1 alpha-2, uppercase.
  country: string;
  postalCode: string | null;
  city: string | null;
  stateOrProvince: string | null;
}

// All assigned ISO 3166-1 alpha-2 codes (officially assigned as of 2024).
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX",
  "AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ",
  "BR","BS","BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK",
  "CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM",
  "DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR",
  "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS",
  "GT","GU","GW","GY","HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN",
  "IO","IQ","IR","IS","IT","JE","JM","JO","JP","KE","KG","KH","KI","KM","KN",
  "KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV",
  "LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ",
  "MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NF","NG","NI",
  "NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM",
  "PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC",
  "SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV",
  "SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR",
  "TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI",
  "VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
]);

// Countries with no (operational, publicly used) postal code system, per the
// Universal Postal Union. Advisory, kept current on a best-effort basis: a
// listed country only relaxes the postal requirement — a seller who does have
// a code can still enter it, and eBay remains the final validator.
export const NO_POSTAL_CODE_COUNTRIES: ReadonlySet<string> = new Set([
  "AE","AG","AN","AO","AW","BF","BI","BJ","BS","BW","BZ","CD","CF","CG","CI",
  "CK","CM","DJ","DM","ER","FJ","GA","GD","GH","GM","GN","GQ","GY","HK","JM",
  "KI","KM","KN","KP","LC","ML","MO","MR","MS","MW","NR","NU","QA","RW","SB",
  "SC","SL","SO","SR","ST","SY","TD","TF","TK","TL","TO","TT","TV","TZ","UG",
  "VU","YE","ZW",
]);

export function countryUsesPostalCodes(country: string): boolean {
  return !NO_POSTAL_CODE_COUNTRIES.has(country.toUpperCase());
}

// Charset sanity only — never a per-country format. Letters, digits, spaces,
// and hyphens cover every real postal system (incl. GB, NL, CA, BR, JP).
const POSTAL_CHARSET = /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/;

export interface ShipFromValidation {
  ok: boolean;
  // Field-level messages the form can render inline; empty when ok.
  errors: Partial<Record<keyof ShipFromLocation, string>>;
}

// Normalises then validates raw form/API input. Returns the cleaned location
// alongside the verdict so callers persist exactly what was validated.
export function validateShipFrom(raw: {
  country?: unknown;
  postalCode?: unknown;
  city?: unknown;
  stateOrProvince?: unknown;
}): ShipFromValidation & { value: ShipFromLocation } {
  const str = (v: unknown): string =>
    typeof v === "string" ? v.trim() : "";

  const country = str(raw.country).toUpperCase();
  const postalCode = str(raw.postalCode);
  const city = str(raw.city);
  const stateOrProvince = str(raw.stateOrProvince);

  const errors: ShipFromValidation["errors"] = {};

  if (!/^[A-Z]{2}$/.test(country) || !ISO_COUNTRY_CODES.has(country)) {
    errors.country = "Pick your country.";
  }

  if (postalCode) {
    if (!POSTAL_CHARSET.test(postalCode)) {
      errors.postalCode =
        "That postal code has characters we can't send to eBay — letters, numbers, spaces, and hyphens only.";
    }
  } else if (!errors.country && countryUsesPostalCodes(country)) {
    errors.postalCode = "Enter the postal code you ship from.";
  } else if (!errors.country) {
    // No postal system → eBay needs city + state/province instead.
    if (!city) errors.city = "Enter the city you ship from.";
    if (!stateOrProvince)
      errors.stateOrProvince = "Enter your state, province, or region.";
  }

  if (city.length > 80) errors.city = "City is too long.";
  if (stateOrProvince.length > 80)
    errors.stateOrProvince = "State or province is too long.";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      country,
      postalCode: postalCode || null,
      city: city || null,
      stateOrProvince: stateOrProvince || null,
    },
  };
}
