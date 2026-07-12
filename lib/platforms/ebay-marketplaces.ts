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
  // Vetted domestic shipping service for auto-created default fulfillment
  // policies (docs/design/ebay-seller-readiness.md). Absent → the default
  // policy is created with handling time only and the seller picks a
  // service on eBay; add the marketplace's code here to close that gap.
  defaultShippingService?: { carrierCode: string; serviceCode: string };
}

const MARKETPLACE_BY_COUNTRY: Record<string, EbayMarketplace> = {
  US: {
    id: "EBAY_US", currency: "USD", categoryTreeId: "0", contentLanguage: "en-US",
    defaultShippingService: { carrierCode: "USPS", serviceCode: "USPSGroundAdvantage" },
  },
  CA: {
    id: "EBAY_CA", currency: "CAD", categoryTreeId: "2", contentLanguage: "en-CA",
    defaultShippingService: { carrierCode: "CanadaPost", serviceCode: "CA_PostRegularParcel" },
  },
  GB: {
    id: "EBAY_GB", currency: "GBP", categoryTreeId: "3", contentLanguage: "en-GB",
    defaultShippingService: { carrierCode: "RoyalMail", serviceCode: "UK_RoyalMailSecondClassStandard" },
  },
  AU: {
    id: "EBAY_AU", currency: "AUD", categoryTreeId: "15", contentLanguage: "en-AU",
    defaultShippingService: { carrierCode: "AustraliaPost", serviceCode: "AU_Regular" },
  },
  AT: { id: "EBAY_AT", currency: "EUR", categoryTreeId: "16", contentLanguage: "de-DE" },
  BE: { id: "EBAY_BE", currency: "EUR", categoryTreeId: "123", contentLanguage: "nl-BE" },
  FR: { id: "EBAY_FR", currency: "EUR", categoryTreeId: "71", contentLanguage: "fr-FR" },
  DE: {
    id: "EBAY_DE", currency: "EUR", categoryTreeId: "77", contentLanguage: "de-DE",
    defaultShippingService: { carrierCode: "DHL", serviceCode: "DE_DHLPaket" },
  },
  IT: { id: "EBAY_IT", currency: "EUR", categoryTreeId: "101", contentLanguage: "it-IT" },
  NL: { id: "EBAY_NL", currency: "EUR", categoryTreeId: "146", contentLanguage: "nl-NL" },
  ES: { id: "EBAY_ES", currency: "EUR", categoryTreeId: "186", contentLanguage: "es-ES" },
  // eBay.ch is German-primary; de-DE is the supported Content-Language value.
  CH: { id: "EBAY_CH", currency: "CHF", categoryTreeId: "193", contentLanguage: "de-DE" },
  // en-IE is not in eBay's accepted Content-Language set; en-GB is.
  IE: { id: "EBAY_IE", currency: "EUR", categoryTreeId: "205", contentLanguage: "en-GB" },
  PL: { id: "EBAY_PL", currency: "PLN", categoryTreeId: "212", contentLanguage: "pl-PL" },
  SG: { id: "EBAY_SG", currency: "SGD", categoryTreeId: "216", contentLanguage: "en-US" },
  HK: { id: "EBAY_HK", currency: "HKD", categoryTreeId: "201", contentLanguage: "zh-HK" },
  MY: { id: "EBAY_MY", currency: "MYR", categoryTreeId: "207", contentLanguage: "en-US" },
  PH: { id: "EBAY_PH", currency: "PHP", categoryTreeId: "211", contentLanguage: "en-US" },
};

export const DEFAULT_EBAY_MARKETPLACE: EbayMarketplace =
  MARKETPLACE_BY_COUNTRY.US;

export function marketplaceForCountry(
  country: string | null | undefined
): EbayMarketplace {
  if (!country) return DEFAULT_EBAY_MARKETPLACE;
  return (
    MARKETPLACE_BY_COUNTRY[country.toUpperCase()] ?? DEFAULT_EBAY_MARKETPLACE
  );
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
