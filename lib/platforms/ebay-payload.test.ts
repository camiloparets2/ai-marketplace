import { describe, it, expect } from "vitest";
import {
  buildEbayInventoryItemPayload,
  buildEbayOfferPayload,
} from "./ebay";
import { marketplaceForCountry } from "./ebay-marketplaces";
import type { ListingInput } from "./types";

const listing: ListingInput = {
  title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones",
  brand: "Sony",
  model: "WH-1000XM4",
  upc: "027242919945",
  condition: "Very Good",
  category: "Electronics > Headphones",
  specs: { Color: "Black", Connectivity: "Bluetooth" },
  price: 149.99,
  shippingCost: 10.4,
};

describe("buildEbayInventoryItemPayload", () => {
  it("maps title, description, aspects, image, UPC, and condition", () => {
    const p = buildEbayInventoryItemPayload(listing, ["https://cdn.example/p.jpg"]);
    expect(p.product.title).toContain("Sony WH-1000XM4");
    expect(p.product.title.length).toBeLessThanOrEqual(80); // eBay limit
    expect(p.product.aspects).toMatchObject({
      Brand: ["Sony"],
      Model: ["WH-1000XM4"],
      Color: ["Black"],
      Connectivity: ["Bluetooth"],
    });
    expect(p.product.imageUrls).toEqual(["https://cdn.example/p.jpg"]);
    expect(p.product.upc).toEqual(["027242919945"]);
    expect(p.condition).toBe("USED_VERY_GOOD");
    expect(p.availability.shipToLocationAvailability.quantity).toBe(1);
  });

  it("omits the upc key entirely when there is none", () => {
    const p = buildEbayInventoryItemPayload(
      { ...listing, upc: null },
      ["https://cdn.example/p.jpg"]
    );
    expect("upc" in p.product).toBe(false);
  });

  it("lists every photo in order, seller's originals first, capped at eBay's 24", () => {
    const urls = Array.from({ length: 26 }, (_, i) => `https://cdn.example/${i}.jpg`);
    const p = buildEbayInventoryItemPayload(listing, urls);
    expect(p.product.imageUrls).toHaveLength(24);
    expect(p.product.imageUrls[0]).toBe("https://cdn.example/0.jpg");
  });
});

describe("buildEbayOfferPayload", () => {
  const policies = {
    fulfillmentPolicyId: "f1",
    paymentPolicyId: "p1",
    returnPolicyId: "r1",
  };

  it("builds a fixed-price US offer with policies and 2-decimal price", () => {
    const p = buildEbayOfferPayload(
      listing,
      "snap-1",
      "112233",
      "loc-1",
      policies,
      marketplaceForCountry("US"),
      false
    );
    expect(p).toMatchObject({
      sku: "snap-1",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      // eBay's Inventory API accepts only GTC for fixed price — explicit.
      listingDuration: "GTC",
      availableQuantity: 1,
      categoryId: "112233",
      merchantLocationKey: "loc-1",
    });
    expect(p.pricingSummary.price).toEqual({ value: "149.99", currency: "USD" });
    expect(p.listingPolicies.fulfillmentPolicyId).toBe("f1");
    expect(p.listingDescription).toContain("Condition");
  });

  it("uses the seller's marketplace and currency — never a US constant", () => {
    const gb = buildEbayOfferPayload(
      listing,
      "snap-2",
      "112233",
      "loc-1",
      policies,
      marketplaceForCountry("GB"),
      false
    );
    expect(gb.marketplaceId).toBe("EBAY_GB");
    expect(gb.pricingSummary.price).toEqual({
      value: "149.99",
      currency: "GBP",
    });

    const de = buildEbayOfferPayload(
      listing,
      "snap-3",
      "112233",
      "loc-1",
      policies,
      marketplaceForCountry("DE"),
      false
    );
    expect(de.marketplaceId).toBe("EBAY_DE");
    expect(de.pricingSummary.price.currency).toBe("EUR");
  });

  // The buyer-paid shipping rule: the app-default fulfillment policy carries
  // no shipping amount, so the offer must charge the buyer the per-item
  // estimate — and must refuse to publish without one.
  describe("shipping charge with the app-default fulfillment policy", () => {
    it("charges the buyer the item's shipping estimate via shippingCostOverrides", () => {
      const p = buildEbayOfferPayload(
        listing,
        "snap-4",
        "112233",
        "loc-1",
        policies,
        marketplaceForCountry("US"),
        true
      );
      expect(p.listingPolicies.shippingCostOverrides).toEqual([
        {
          priority: 1,
          shippingServiceType: "DOMESTIC",
          shippingCost: { value: "10.40", currency: "USD" },
        },
      ]);
    });

    it("never overrides a seller-owned fulfillment policy", () => {
      const p = buildEbayOfferPayload(
        listing,
        "snap-5",
        "112233",
        "loc-1",
        policies,
        marketplaceForCountry("US"),
        false
      );
      expect("shippingCostOverrides" in p.listingPolicies).toBe(false);
    });

    it("REFUSES to publish with unknown shipping — never a silent $0 charge", () => {
      expect(() =>
        buildEbayOfferPayload(
          { ...listing, shippingCost: null },
          "snap-6",
          "112233",
          "loc-1",
          policies,
          marketplaceForCountry("US"),
          true
        )
      ).toThrow(/no shipping cost/i);
    });

    it("omits the override for marketplaces without a vetted default service", () => {
      // PL's default policy has no shippingOptions — nothing to override.
      const p = buildEbayOfferPayload(
        { ...listing, shippingCost: null },
        "snap-7",
        "112233",
        "loc-1",
        policies,
        marketplaceForCountry("PL"),
        true
      );
      expect("shippingCostOverrides" in p.listingPolicies).toBe(false);
    });
  });
});
