// Brand-hallucination guard (docs/design/comps-pricing.md Part 2): a brand
// is only asserted when it was READABLE in the photo. Styling inference —
// the way invented brands end up on listings — always downgrades.

import { describe, it, expect } from "vitest";
import {
  applyBrandGuard,
  foldAspectsIntoSpecs,
  isKnownBrand,
  DOWNGRADED_BRAND_CONFIDENCE,
} from "./brand-guard";
import type { ExtractionResult } from "@/lib/types/extraction";

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: "Leather Chelsea Boots",
    brand: null,
    brandSource: "none",
    model: null,
    upc: null,
    condition: "Good",
    defects: [],
    category: "Clothing > Shoes > Boots",
    handmade: false,
    estimatedYearMade: null,
    craftSupply: false,
    material: null,
    colorPrimary: null,
    colorSecondary: null,
    size: null,
    sizeSystem: null,
    style: null,
    pattern: null,
    specs: {},
    estimatedDimensions: null,
    estimatedWeightLbs: null,
    suggestedShippingService: "USPS_FLAT_RATE_MEDIUM",
    estimatedShippingCost: 16.1,
    suggestedPrice: 45,
    priceRationale: "Comparable used boots sell for $40-60.",
    confidence: { title: 90, category: 88, condition: 85 },
    ...over,
  };
}

describe("applyBrandGuard", () => {
  it("downgrades a styling-only guess to Unbranded — never an invented brand", () => {
    // The hallucination case: nothing readable, but the model "recognizes"
    // the styling as a luxury brand.
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({
        brand: "Gucci",
        brandSource: "inferred",
        confidence: { title: 90, category: 88, condition: 85, brand: 85 },
      })
    );
    expect(out.brand).toBe("Unbranded");
    expect(out.brandSource).toBe("none");
    expect(downgraded).toBe(true);
    expect(out.confidence.brand).toBeLessThanOrEqual(
      DOWNGRADED_BRAND_CONFIDENCE
    );
  });

  it("keeps a niche-but-real brand read off a tag — never cross-checked", () => {
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({
        brand: "Thursday Boot Co",
        brandSource: "tag_or_label",
        confidence: { title: 90, category: 88, condition: 85, brand: 92 },
      })
    );
    expect(out.brand).toBe("Thursday Boot Co");
    expect(downgraded).toBe(false);
  });

  it("downgrades a low-confidence tag read — blurry tags don't assert brands", () => {
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({
        brand: "Sony",
        brandSource: "tag_or_label",
        confidence: { title: 90, category: 88, condition: 85, brand: 55 },
      })
    );
    expect(out.brand).toBe("Unbranded");
    expect(downgraded).toBe(true);
  });

  it("keeps a known brand read from a printed logo", () => {
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({
        brand: "Nike",
        brandSource: "logo",
        confidence: { title: 90, category: 88, condition: 85, brand: 90 },
      })
    );
    expect(out.brand).toBe("Nike");
    expect(downgraded).toBe(false);
  });

  it("downgrades an unrecognized 'logo' brand — the hallucination cross-check", () => {
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({
        brand: "Luxorion Milano",
        brandSource: "logo",
        confidence: { title: 90, category: 88, condition: 85, brand: 90 },
      })
    );
    expect(out.brand).toBe("Unbranded");
    expect(downgraded).toBe(true);
  });

  it("treats an unscored brand claim as a coin-flip → downgrade", () => {
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({ brand: "Sony", brandSource: "tag_or_label" })
    );
    expect(out.brand).toBe("Unbranded");
    expect(downgraded).toBe(true);
  });

  it("leaves a null brand alone (normalized, not downgraded)", () => {
    const { extraction: out, downgraded } = applyBrandGuard(
      extraction({ brand: null, brandSource: "inferred" })
    );
    expect(out.brand).toBeNull();
    expect(out.brandSource).toBe("none");
    expect(downgraded).toBe(false);
  });
});

describe("isKnownBrand", () => {
  it("matches case- and punctuation-insensitively", () => {
    expect(isKnownBrand("LEVI'S")).toBe(true);
    expect(isKnownBrand("The North Face")).toBe(true);
    expect(isKnownBrand("Definitely Not A Brand")).toBe(false);
  });
});

describe("foldAspectsIntoSpecs", () => {
  it("folds aspect fields into specs under their eBay aspect names", () => {
    const out = foldAspectsIntoSpecs(
      extraction({
        material: "Leather",
        colorPrimary: "Brown",
        size: "10.5",
        sizeSystem: "US",
        style: "Chelsea Boot",
        pattern: "Solid",
      })
    );
    expect(out.specs).toMatchObject({
      Material: "Leather",
      Color: "Brown",
      Size: "10.5",
      "Size System": "US",
      Style: "Chelsea Boot",
      Pattern: "Solid",
    });
    expect(out.specs["Secondary Color"]).toBeUndefined();
  });

  it("never overwrites a spec key Claude already populated", () => {
    const out = foldAspectsIntoSpecs(
      extraction({ colorPrimary: "Brown", specs: { Color: "Chestnut" } })
    );
    expect(out.specs.Color).toBe("Chestnut");
  });
});
