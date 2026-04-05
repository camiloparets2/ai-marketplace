import type { ShippingService } from "@/lib/types/extraction";

export interface ShippingRate {
  service: ShippingService;
  displayName: string;
  cost: number | null; // null when MANUAL_ESTIMATE_NEEDED
}

// USPS Flat Rate prices as of 2024. Update when USPS adjusts rates.
// Source: https://www.usps.com/ship/priority-mail.htm
const FLAT_RATE_TABLE: Record<
  Exclude<ShippingService, "MANUAL_ESTIMATE_NEEDED">,
  number
> = {
  USPS_FLAT_RATE_SMALL: 10.4,
  USPS_FLAT_RATE_MEDIUM: 16.1,
  USPS_FLAT_RATE_LARGE: 22.45,
};

// SHIPPING_DISPLAY_NAMES is the authoritative display string source.
// Import from extraction.ts to keep them in sync.
import { SHIPPING_DISPLAY_NAMES } from "@/lib/types/extraction";

/**
 * Returns the shipping cost and display metadata for a given service.
 * Returns cost: null for MANUAL_ESTIMATE_NEEDED — caller must prompt
 * the user to enter shipping manually before creating a listing.
 *
 * Note: MANUAL_ESTIMATE_NEEDED covers two distinct cases that the UI
 * should distinguish (Phase 2 TODO):
 *   1. Claude confidence too low to suggest a box
 *   2. Item physically too large for any flat rate box
 */
export function getShippingRate(service: ShippingService): ShippingRate {
  if (service === "MANUAL_ESTIMATE_NEEDED") {
    return {
      service,
      displayName: SHIPPING_DISPLAY_NAMES.MANUAL_ESTIMATE_NEEDED,
      cost: null,
    };
  }

  return {
    service,
    displayName: SHIPPING_DISPLAY_NAMES[service],
    cost: FLAT_RATE_TABLE[service],
  };
}

/**
 * Returns all available flat rate services with their costs.
 * Used to render the shipping selector when the user overrides
 * the suggested service.
 */
export function getAllFlatRates(): ShippingRate[] {
  return (
    Object.keys(FLAT_RATE_TABLE) as Exclude<
      ShippingService,
      "MANUAL_ESTIMATE_NEEDED"
    >[]
  ).map(getShippingRate);
}
