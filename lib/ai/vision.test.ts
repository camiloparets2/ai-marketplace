import { describe, it, expect, vi } from "vitest";
import { RateLimitError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { identifyItem, overallConfidence, VisionError } from "./vision";
import type { VisionClient } from "./vision";
import type { ExtractionResult } from "@/lib/types/extraction";

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: "Sony WH-1000XM4 Wireless Headphones",
    brand: "Sony",
    brandSource: "tag_or_label",
    model: "WH-1000XM4",
    upc: null,
    condition: "Very Good",
    defects: ["light scuff on right earcup"],
    category: "Electronics > Headphones",
    handmade: false,
    estimatedYearMade: 2020,
    craftSupply: false,
    material: null,
    colorPrimary: "Black",
    colorSecondary: null,
    size: null,
    sizeSystem: null,
    style: null,
    pattern: null,
    specs: { Color: "Black" },
    estimatedDimensions: null,
    estimatedWeightLbs: null,
    suggestedShippingService: "USPS_FLAT_RATE_MEDIUM",
    estimatedShippingCost: 16.1,
    suggestedPrice: 165,
    priceRationale:
      "Used WH-1000XM4 in Very Good condition sells for $150-180 on eBay; $165 targets a quick sale.",
    confidence: { title: 95, category: 90, condition: 85, brand: 92 },
    ...over,
  };
}

function clientReturning(content: unknown): VisionClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ content }),
    } as unknown as VisionClient["messages"],
  };
}

describe("overallConfidence", () => {
  it("is the minimum of the identity-critical scores, scaled to 0-1", () => {
    expect(
      overallConfidence(
        extraction({ confidence: { title: 95, category: 70, condition: 85 } })
      )
    ).toBeCloseTo(0.7);
  });

  it("treats an unscored critical field as 50, not a pass", () => {
    expect(
      overallConfidence(extraction({ confidence: { title: 95, category: 90 } }))
    ).toBeCloseTo(0.5);
  });

  it("clamps to the 0-1 range", () => {
    expect(
      overallConfidence(
        extraction({ confidence: { title: 120, category: 110, condition: 115 } })
      )
    ).toBe(1);
  });
});

describe("identifyItem", () => {
  it("returns the extraction with overall confidence and defects", async () => {
    const client = clientReturning([
      { type: "tool_use", name: "extract_listing", input: extraction() },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.extraction.title).toBe("Sony WH-1000XM4 Wireless Headphones");
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.defects).toEqual(["light scuff on right earcup"]);
  });

  it("passes the suggested price and rationale through untouched", async () => {
    // Regression: e548dab dropped these from the schema and the review UI
    // lost its pre-filled editable price (docs/design/ship-from-location.md).
    const client = clientReturning([
      { type: "tool_use", name: "extract_listing", input: extraction() },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.extraction.suggestedPrice).toBe(165);
    expect(result.extraction.priceRationale).toMatch(/\$150-180/);
  });

  it("normalises omitted price fields to null, never undefined", async () => {
    const bare = extraction();
    delete (bare as Partial<ExtractionResult>).suggestedPrice;
    delete (bare as Partial<ExtractionResult>).priceRationale;
    const client = clientReturning([
      { type: "tool_use", name: "extract_listing", input: bare },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.extraction.suggestedPrice).toBeNull();
    expect(result.extraction.priceRationale).toBeNull();
  });

  it("defaults defects to [] when the model omits them", async () => {
    const bare = extraction();
    // simulate an older/degraded response without the defects field
    delete (bare as Partial<ExtractionResult>).defects;
    const client = clientReturning([
      { type: "tool_use", name: "extract_listing", input: bare },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.defects).toEqual([]);
  });

  it("replaces a styling-inferred brand with Unbranded and caps confidence below the auto-post bar", async () => {
    const client = clientReturning([
      {
        type: "tool_use",
        name: "extract_listing",
        input: extraction({
          brand: "Gucci",
          brandSource: "inferred",
          confidence: { title: 95, category: 90, condition: 85, brand: 85 },
        }),
      },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.extraction.brand).toBe("Unbranded");
    // Capped under the 0.8 guardrail bar → the item routes to review.
    expect(result.confidence).toBeLessThan(0.8);
  });

  it("treats an omitted brandSource on a claimed brand as inferred → Unbranded", async () => {
    const bare = extraction({ brand: "Gucci" });
    delete (bare as Partial<ExtractionResult>).brandSource;
    const client = clientReturning([
      { type: "tool_use", name: "extract_listing", input: bare },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.extraction.brand).toBe("Unbranded");
  });

  it("folds aspect fields into specs under their eBay aspect names", async () => {
    const client = clientReturning([
      {
        type: "tool_use",
        name: "extract_listing",
        input: extraction({ material: "Aluminum", style: "Over-Ear" }),
      },
    ]);
    const result = await identifyItem("aGk=", "image/jpeg", client);
    expect(result.extraction.specs).toMatchObject({
      Material: "Aluminum",
      Style: "Over-Ear",
      Color: "Black", // pre-existing spec key wins over colorPrimary
    });
  });

  it("throws bad_response when no tool_use block comes back", async () => {
    const client = clientReturning([{ type: "text", text: "hello" }]);
    await expect(identifyItem("aGk=", "image/jpeg", client)).rejects.toThrow(
      VisionError
    );
    await expect(
      identifyItem("aGk=", "image/jpeg", client)
    ).rejects.toMatchObject({ kind: "bad_response", retryable: true });
  });

  it("maps SDK rate limiting to a retryable rate_limited error", async () => {
    const err = Object.assign(Object.create(RateLimitError.prototype), {
      message: "429",
    });
    const client: VisionClient = {
      messages: {
        create: vi.fn().mockRejectedValue(err),
      } as unknown as VisionClient["messages"],
    };
    await expect(
      identifyItem("aGk=", "image/jpeg", client)
    ).rejects.toMatchObject({ kind: "rate_limited", retryable: true });
  });

  it("maps SDK timeouts to a retryable timeout error", async () => {
    const err = Object.assign(
      Object.create(APIConnectionTimeoutError.prototype),
      { message: "timed out" }
    );
    const client: VisionClient = {
      messages: {
        create: vi.fn().mockRejectedValue(err),
      } as unknown as VisionClient["messages"],
    };
    await expect(
      identifyItem("aGk=", "image/jpeg", client)
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });
});
