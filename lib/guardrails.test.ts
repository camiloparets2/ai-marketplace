import { describe, it, expect } from "vitest";
import {
  confidenceGate,
  priceFloorGate,
  priceRangeGate,
  prohibitedItemGate,
  veroBrandGate,
  photoQualityGate,
  evaluateGuardrails,
  GUARDRAIL_DEFAULTS,
} from "./guardrails";
import type { GuardrailInput } from "./guardrails";

// A real-enough JPEG: magic bytes + padding past the size bar.
function jpegBytes(sizeKb: number): Uint8Array {
  const bytes = new Uint8Array(sizeKb * 1024);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

function passingInput(over: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    confidence: 0.9,
    price: 49.99,
    floor: 25,
    title: "Sony WH-1000XM4 Wireless Headphones",
    brand: "Sony",
    category: "Electronics > Headphones",
    specs: { Color: "Black" },
    defects: [],
    photoBytes: jpegBytes(80),
    ...over,
  };
}

describe("confidenceGate", () => {
  it("passes at and above the 0.80 bar, fails below", () => {
    expect(confidenceGate(0.8).pass).toBe(true);
    expect(confidenceGate(0.95).pass).toBe(true);
    expect(confidenceGate(0.79).pass).toBe(false);
  });
});

describe("priceFloorGate", () => {
  it("fails when price is below the computed floor", () => {
    expect(priceFloorGate(20, 25).pass).toBe(false);
    expect(priceFloorGate(25, 25).pass).toBe(true);
  });
});

describe("priceRangeGate", () => {
  it("fails outside the sane $5–$2000 auto-post range", () => {
    expect(priceRangeGate(4.99).pass).toBe(false);
    expect(priceRangeGate(5).pass).toBe(true);
    expect(priceRangeGate(2000).pass).toBe(true);
    expect(priceRangeGate(2000.01).pass).toBe(false);
  });
});

describe("prohibitedItemGate", () => {
  it("flags restricted keywords as whole words", () => {
    expect(prohibitedItemGate("Vintage hunting rifle with ammo").pass).toBe(false);
    expect(prohibitedItemGate("Replica Rolex Submariner").pass).toBe(false);
    expect(prohibitedItemGate("Recalled infant sleeper").pass).toBe(false);
    expect(prohibitedItemGate("CBD gummies 500mg").pass).toBe(false);
  });

  it("does not false-positive on substrings of ordinary words", () => {
    // 'gunmetal' contains 'gun'; word boundary must protect it
    expect(prohibitedItemGate("Gunmetal gray watch band").pass).toBe(true);
    expect(prohibitedItemGate("Sony headphones, black").pass).toBe(true);
  });
});

describe("veroBrandGate", () => {
  it("routes VeRO-heavy brands to review from either brand or title", () => {
    expect(veroBrandGate("Louis Vuitton", "Neverfull MM tote").pass).toBe(false);
    expect(veroBrandGate(null, "Authentic GUCCI belt 90cm").pass).toBe(false);
  });

  it("passes ordinary brands", () => {
    expect(veroBrandGate("Sony", "WH-1000XM4 headphones").pass).toBe(true);
  });
});

describe("photoQualityGate", () => {
  it("fails on missing, tiny, or non-image photos", () => {
    expect(photoQualityGate(null).pass).toBe(false);
    expect(photoQualityGate(jpegBytes(5)).pass).toBe(false); // 5KB thumbnail
    expect(photoQualityGate(new Uint8Array(50 * 1024)).pass).toBe(false); // no magic bytes
  });

  it("passes a normal-size real image", () => {
    expect(photoQualityGate(jpegBytes(80)).pass).toBe(true);
    expect(
      photoQualityGate(jpegBytes(Math.ceil(GUARDRAIL_DEFAULTS.minPhotoBytes / 1024)))
        .pass
    ).toBe(true);
  });
});

describe("evaluateGuardrails", () => {
  it("auto-posts only when every gate passes", () => {
    const verdict = evaluateGuardrails(passingInput());
    expect(verdict.autoPost).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.gates).toHaveLength(6);
  });

  it("one failing gate blocks auto-post and is reported", () => {
    const verdict = evaluateGuardrails(passingInput({ confidence: 0.5 }));
    expect(verdict.autoPost).toBe(false);
    expect(verdict.failures.map((f) => f.gate)).toEqual(["confidence"]);
    expect(verdict.failures[0].reason).toContain("0.50");
  });

  it("collects multiple failures at once", () => {
    const verdict = evaluateGuardrails(
      passingInput({ confidence: 0.4, price: 3, floor: 10, photoBytes: null })
    );
    expect(verdict.autoPost).toBe(false);
    expect(verdict.failures.map((f) => f.gate)).toEqual([
      "confidence",
      "price_floor",
      "price_range",
      "photo_quality",
    ]);
  });

  it("scans specs and defects text for prohibited terms too", () => {
    const verdict = evaluateGuardrails(
      passingInput({ specs: { Material: "elephant ivory inlay" } })
    );
    expect(verdict.autoPost).toBe(false);
    expect(verdict.failures.map((f) => f.gate)).toEqual(["prohibited_item"]);
  });
});
