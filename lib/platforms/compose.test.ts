import { describe, it, expect } from "vitest";
import {
  composeListing,
  truncateTitle,
  buildEtsyTags,
  assistCopyText,
  ebayHtmlDescription,
  TITLE_LIMITS,
  ETSY_MAX_TAGS,
  ETSY_TAG_MAX_LENGTH,
  EBAY_CONDITION_MAP,
} from "@/lib/platforms/compose";
import { ALL_PLATFORMS } from "@/lib/platforms/types";
import type { ListingInput } from "@/lib/platforms/types";

const baseInput: ListingInput = {
  title: "Sony WH-1000XM4 Wireless Noise Cancelling Over-Ear Headphones Black",
  brand: "Sony",
  model: "WH-1000XM4",
  upc: "027242919952",
  condition: "Very Good",
  category: "Electronics > Headphones",
  specs: { Color: "Black", Connectivity: "Bluetooth 5.0" },
  price: 179.99,
  shippingCost: 10.4,
};

describe("truncateTitle", () => {
  it("returns short titles unchanged", () => {
    expect(truncateTitle("Short title", 80)).toBe("Short title");
  });

  it("truncates on a word boundary within the limit", () => {
    const long = "word ".repeat(30).trim(); // 149 chars
    const result = truncateTitle(long, 80);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("word")).toBe(true);
  });

  it("hard-cuts when the word boundary would cost too many characters", () => {
    const long = `tiny ${"x".repeat(100)}`;
    const result = truncateTitle(long, 80);
    expect(result.length).toBe(80);
  });

  it("trims surrounding whitespace", () => {
    expect(truncateTitle("  padded  ", 80)).toBe("padded");
  });
});

describe("composeListing", () => {
  it("respects every platform's title limit", () => {
    const longInput = { ...baseInput, title: "very long word ".repeat(20) };
    for (const platform of ALL_PLATFORMS) {
      const composed = composeListing(platform, longInput);
      expect(composed.title.length).toBeLessThanOrEqual(
        TITLE_LIMITS[platform]
      );
    }
  });

  it("includes brand, model, condition, and specs in the description", () => {
    const composed = composeListing("ebay", baseInput);
    expect(composed.description).toContain("Brand: Sony");
    expect(composed.description).toContain("Model: WH-1000XM4");
    expect(composed.description).toContain("Condition: Very Good");
    expect(composed.description).toContain("Color: Black");
  });

  it("includes flat-rate shipping cost when known", () => {
    const composed = composeListing("facebook", baseInput);
    expect(composed.description).toContain("$10.40");
  });

  it("falls back to 'calculated at sale' when shipping is unknown", () => {
    const composed = composeListing("facebook", {
      ...baseInput,
      shippingCost: null,
    });
    expect(composed.description).toContain("Shipping calculated at sale.");
  });

  it("only generates tags for Etsy", () => {
    expect(composeListing("etsy", baseInput).tags.length).toBeGreaterThan(0);
    expect(composeListing("ebay", baseInput).tags).toEqual([]);
    expect(composeListing("facebook", baseInput).tags).toEqual([]);
  });
});

describe("buildEtsyTags", () => {
  it("caps at 13 tags of at most 20 characters", () => {
    const specs: Record<string, string> = {};
    for (let i = 0; i < 30; i++) specs[`Feature number ${i}`] = `Value ${i}`;
    const tags = buildEtsyTags({ ...baseInput, specs });
    expect(tags.length).toBeLessThanOrEqual(ETSY_MAX_TAGS);
    for (const tag of tags) {
      expect(tag.length).toBeLessThanOrEqual(ETSY_TAG_MAX_LENGTH);
    }
  });

  it("drops over-length candidates instead of truncating them", () => {
    const tags = buildEtsyTags({
      ...baseInput,
      brand: "An Extremely Long Brand Name Co.",
    });
    expect(tags).not.toContain("An Extremely Long Br");
  });

  it("deduplicates case-insensitively", () => {
    const tags = buildEtsyTags({
      ...baseInput,
      brand: "sony",
      specs: { Maker: "Sony" },
    });
    expect(tags.filter((t) => t.toLowerCase() === "sony")).toHaveLength(1);
  });

  it("splits category path into separate tags", () => {
    const tags = buildEtsyTags(baseInput);
    expect(tags).toContain("Electronics");
    expect(tags).toContain("Headphones");
  });
});

describe("EBAY_CONDITION_MAP", () => {
  it("maps every app condition to an eBay enum", () => {
    expect(EBAY_CONDITION_MAP).toEqual({
      New: "NEW",
      "Like New": "LIKE_NEW",
      "Very Good": "USED_VERY_GOOD",
      Good: "USED_GOOD",
      Acceptable: "USED_ACCEPTABLE",
    });
  });
});

describe("assistCopyText", () => {
  it("leads with title then price for paste-in-order form filling", () => {
    const text = assistCopyText("facebook", baseInput);
    const lines = text.split("\n");
    expect(lines[0].length).toBeLessThanOrEqual(TITLE_LIMITS.facebook);
    expect(lines[1]).toBe("$179.99");
  });
});

describe("ebayHtmlDescription", () => {
  it("escapes HTML-sensitive characters", () => {
    const html = ebayHtmlDescription({
      ...baseInput,
      title: 'Cables <2m> & "adapters"',
    });
    expect(html).toContain("&lt;2m&gt; &amp;");
    expect(html).not.toContain("<2m>");
  });

  it("renders spec lines as list items", () => {
    const html = ebayHtmlDescription(baseInput);
    expect(html).toContain("<li>Brand: Sony</li>");
  });
});
