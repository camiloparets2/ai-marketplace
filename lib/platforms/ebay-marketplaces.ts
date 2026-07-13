// eBay marketplace metadata derived from the seller's ship-from country
// (docs/design/ship-from-location.md). Pure and dependency-free.
//
// The marketplace decides four things the publish chain used to hardcode to
// the US: the offer's marketplaceId, its currency, the Taxonomy category tree
// used for category suggestions, and the Content-Language header eBay
// requires on Inventory API writes.
//
// Countries without their own eBay marketplace fall back to EBAY_US/USD —
// that is where eBay routes such sellers today. The seller's marketplace is
// resolved once and cached in platform_connections.meta, so improving this
// table later automatically applies on the next connect/publish.

export interface EbayMarketplace {
  id: string; // MarketplaceIdEnum, e.g. "EBAY_GB"
  currency: string; // ISO 4217 of the marketplace, e.g. "GBP"
  categoryTreeId: string; // Taxonomy API category_tree id
  contentLanguage: string; // value eBay accepts in Content-Language
  domain: string; // consumer site host (without www.), e.g. "ebay.co.uk"
  // Vetted domestic shipping service for auto-created default fulfillment
  // policies (docs/design/ebay-seller-readiness.md). Absent → the default
  // policy is created with handling time only and the seller picks a
  // service on eBay; add the marketplace's code here to close that gap.
  defaultShippingService?: { carrierCode: string; serviceCode: string };
  // Ordered EXTRA service codes tried at policy-creation time if the primary
  // is rejected by eBay ("Please select a valid shipping service", errorId
  // 20403). Sandbox and some marketplaces accept a different subset of codes
  // than production, so we never hardcode a single option — see
  // domesticShippingCandidates(). Primary is tried first, then these in order.
  shippingServiceFallbacks?: Array<{ carrierCode: string; serviceCode: string }>;
  // Placeholder buyer-paid FLAT_RATE amount the policy REQUIRES: eBay rejects
  // a buyer-paid (freeShipping:false) flat-rate service with no shippingCost
  // (that is the real cause behind the misleading "valid shipping service"
  // error). The per-listing charge is overridden by the offer's
  // shippingCostOverrides, so this is only a never-silently-free positive
  // default. In the marketplace currency.
  shippingCostBaseline?: number;
}

const MARKETPLACE_BY_COUNTRY: Record<string, EbayMarketplace> = {
  US: {
    id: "EBAY_US", currency: "USD", categoryTreeId: "0", contentLanguage: "en-US", domain: "ebay.com",
    defaultShippingService: { carrierCode: "USPS", serviceCode: "USPSGroundAdvantage" },
    // USPSGroundAdvantage is the current USPS ground service; USPSPriority is
    // the long-standing, universally-accepted fallback (esp. in Sandbox),
    // then USPSParcel (Parcel Select). Tried in order if eBay rejects one.
    shippingServiceFallbacks: [
      { carrierCode: "USPS", serviceCode: "USPSPriority" },
      { carrierCode: "USPS", serviceCode: "USPSParcel" },
    ],
    shippingCostBaseline: 9.99,
  },
  CA: {
    id: "EBAY_CA", currency: "CAD", categoryTreeId: "2", contentLanguage: "en-CA", domain: "ebay.ca",
    defaultShippingService: { carrierCode: "CanadaPost", serviceCode: "CA_PostRegularParcel" },
    shippingCostBaseline: 14.99,
  },
  GB: {
    id: "EBAY_GB", currency: "GBP", categoryTreeId: "3", contentLanguage: "en-GB", domain: "ebay.co.uk",
    defaultShippingService: { carrierCode: "RoyalMail", serviceCode: "UK_RoyalMailSecondClassStandard" },
    shippingCostBaseline: 3.99,
  },
  AU: {
    id: "EBAY_AU", currency: "AUD", categoryTreeId: "15", contentLanguage: "en-AU", domain: "ebay.com.au",
    defaultShippingService: { carrierCode: "AustraliaPost", serviceCode: "AU_Regular" },
    shippingCostBaseline: 12.99,
  },
  AT: { id: "EBAY_AT", currency: "EUR", categoryTreeId: "16", contentLanguage: "de-DE", domain: "ebay.at" },
  BE: { id: "EBAY_BE", currency: "EUR", categoryTreeId: "123", contentLanguage: "nl-BE", domain: "ebay.be" },
  FR: { id: "EBAY_FR", currency: "EUR", categoryTreeId: "71", contentLanguage: "fr-FR", domain: "ebay.fr" },
  DE: {
    id: "EBAY_DE", currency: "EUR", categoryTreeId: "77", contentLanguage: "de-DE", domain: "ebay.de",
    defaultShippingService: { carrierCode: "DHL", serviceCode: "DE_DHLPaket" },
  },
  IT: { id: "EBAY_IT", currency: "EUR", categoryTreeId: "101", contentLanguage: "it-IT", domain: "ebay.it" },
  NL: { id: "EBAY_NL", currency: "EUR", categoryTreeId: "146", contentLanguage: "nl-NL", domain: "ebay.nl" },
  ES: { id: "EBAY_ES", currency: "EUR", categoryTreeId: "186", contentLanguage: "es-ES", domain: "ebay.es" },
  // eBay.ch is German-primary; de-DE is the supported Content-Language value.
  CH: { id: "EBAY_CH", currency: "CHF", categoryTreeId: "193", contentLanguage: "de-DE", domain: "ebay.ch" },
  // en-IE is not in eBay's accepted Content-Language set; en-GB is.
  IE: { id: "EBAY_IE", currency: "EUR", categoryTreeId: "205", contentLanguage: "en-GB", domain: "ebay.ie" },
  PL: { id: "EBAY_PL", currency: "PLN", categoryTreeId: "212", contentLanguage: "pl-PL", domain: "ebay.pl" },
  SG: { id: "EBAY_SG", currency: "SGD", categoryTreeId: "216", contentLanguage: "en-US", domain: "ebay.com.sg" },
  HK: { id: "EBAY_HK", currency: "HKD", categoryTreeId: "201", contentLanguage: "zh-HK", domain: "ebay.com.hk" },
  MY: { id: "EBAY_MY", currency: "MYR", categoryTreeId: "207", contentLanguage: "en-US", domain: "ebay.com.my" },
  PH: { id: "EBAY_PH", currency: "PHP", categoryTreeId: "211", contentLanguage: "en-US", domain: "ebay.ph" },
};

export const DEFAULT_EBAY_MARKETPLACE: EbayMarketplace =
  MARKETPLACE_BY_COUNTRY.US;

// Ordered, de-duplicated list of domestic shipping services to try when
// creating the default fulfillment policy: the primary first, then the
// fallbacks. Empty when the marketplace has no vetted service — the policy is
// then created with handling time only. Never hardcodes a single option.
export function domesticShippingCandidates(
  m: EbayMarketplace
): Array<{ carrierCode: string; serviceCode: string }> {
  const out: Array<{ carrierCode: string; serviceCode: string }> = [];
  const seen = new Set<string>();
  for (const s of [m.defaultShippingService, ...(m.shippingServiceFallbacks ?? [])]) {
    if (s && !seen.has(s.serviceCode)) {
      seen.add(s.serviceCode);
      out.push(s);
    }
  }
  return out;
}

export function marketplaceForCountry(
  country: string | null | undefined
): EbayMarketplace {
  if (!country) return DEFAULT_EBAY_MARKETPLACE;
  return (
    MARKETPLACE_BY_COUNTRY[country.toUpperCase()] ?? DEFAULT_EBAY_MARKETPLACE
  );
}

// Where "Finish your eBay seller setup →" sends the user — eBay's seller
// onboarding entry on the seller's OWN marketplace (ebay.co.uk, ebay.de, …),
// never hardcoded ebay.com.
export function sellerRegistrationUrl(marketplace: EbayMarketplace): string {
  return `https://www.${marketplace.domain}/sl/sell`;
}

// Resolve a stored marketplace id (from connection meta) back to its full
// metadata; null when the id is unknown — callers then re-derive from country.
export function marketplaceById(
  id: string | null | undefined
): EbayMarketplace | null {
  if (!id) return null;
  for (const marketplace of Object.values(MARKETPLACE_BY_COUNTRY)) {
    if (marketplace.id === id) return marketplace;
  }
  return null;
}
