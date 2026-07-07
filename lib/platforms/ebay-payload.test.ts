import { describe, it, expect } from "vitest";
import {
  buildEbayInventoryItemPayload,
  buildEbayOfferPayload,
} from "./ebay";
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
    const p = buildEbayInventoryItemPayload(listing, "https://cdn.example/p.jpg");
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
      "https://cdn.example/p.jpg"
    );
    expect("upc" in p.product).toBe(false);
  });
});

describe("buildEbayOfferPayload", () => {
  it("builds a fixed-price US offer with policies and 2-decimal price", () => {
    const p = buildEbayOfferPayload(listing, "snap-1", "112233", "loc-1", {
      fulfillmentPolicyId: "f1",
      paymentPolicyId: "p1",
      returnPolicyId: "r1",
    });
    expect(p).toMatchObject({
      sku: "snap-1",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId: "112233",
      merchantLocationKey: "loc-1",
    });
    expect(p.pricingSummary.price).toEqual({ value: "149.99", currency: "USD" });
    expect(p.listingPolicies.fulfillmentPolicyId).toBe("f1");
    expect(p.listingDescription).toContain("Condition");
  });
});
