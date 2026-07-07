import { describe, it, expect, vi } from "vitest";
import { runPipeline, resolvePublishMode } from "./pipeline";
import type { PipelineDeps, PipelineInput } from "./pipeline";
import type { IdentifiedItem } from "@/lib/ai/vision";
import type { ExtractionResult } from "@/lib/types/extraction";
import { decidePrice } from "./pricing";
import { evaluateGuardrails } from "./guardrails";

// A base64 image that passes the photo quality gate: JPEG magic bytes, 30KB.
function goodImageBase64(): string {
  const bytes = Buffer.alloc(30 * 1024);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.toString("base64");
}

const extraction: ExtractionResult = {
  title: "Sony WH-1000XM4 Wireless Headphones",
  brand: "Sony",
  model: "WH-1000XM4",
  upc: null,
  condition: "Very Good",
  defects: ["light scuff on right earcup"],
  category: "Electronics > Headphones",
  specs: { Color: "Black" },
  estimatedDimensions: null,
  estimatedWeightLbs: null,
  suggestedShippingService: "USPS_FLAT_RATE_MEDIUM",
  estimatedShippingCost: 16.1,
  confidence: { title: 95, category: 90, condition: 85 },
};

const identified: IdentifiedItem = {
  extraction,
  confidence: 0.85,
  defects: extraction.defects,
};

const input: PipelineInput = {
  userId: "user-1",
  imageBase64: goodImageBase64(),
  mimeType: "image/jpeg",
  costBasis: 40,
  targetPrice: null,
};

function fakeDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    identify: vi.fn().mockResolvedValue(identified),
    hostPhoto: vi.fn().mockResolvedValue("https://cdn.example/p.jpg"),
    createDraft: vi.fn().mockResolvedValue("item-1"),
    price: decidePrice,
    recordPrice: vi.fn().mockResolvedValue(undefined),
    setPrice: vi.fn().mockResolvedValue(undefined),
    getEbayConnection: vi.fn().mockResolvedValue({
      userId: "user-1",
      platform: "ebay",
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3_600_000,
      meta: {},
    }),
    publishEbay: vi.fn().mockResolvedValue({
      url: "https://sandbox.ebay.com/itm/123",
      listingId: "123",
      offerId: "off-1",
      sku: "snap-1",
    }),
    recordListing: vi.fn().mockResolvedValue(undefined),
    markListed: vi.fn().mockResolvedValue(undefined),
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    setReview: vi.fn().mockResolvedValue(undefined),
    guardrails: evaluateGuardrails,
    publishMode: () => "sandbox" as const,
    ...over,
  };
}

describe("runPipeline — happy path (sandbox)", () => {
  it("identifies, persists, prices, publishes, and records the listing", async () => {
    const deps = fakeDeps();
    const result = await runPipeline(input, deps);

    // draft persisted with identification facts
    expect(deps.createDraft).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        title: extraction.title,
        defects: ["light scuff on right earcup"],
        idConfidence: 0.85,
        costOfGoods: 40,
      }),
      "https://cdn.example/p.jpg"
    );

    // price decision recorded and stamped on the item
    expect(deps.recordPrice).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      expect.objectContaining({ strategy: "floor_markup" })
    );
    expect(deps.setPrice).toHaveBeenCalledWith("user-1", "item-1", result.price.price);

    // published at the engine's price, listing recorded, item listed
    expect(deps.publishEbay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ price: result.price.price }),
      "https://cdn.example/p.jpg"
    );
    expect(deps.recordListing).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      expect.objectContaining({ platform: "ebay", externalId: "123" }),
      result.price.price
    );
    expect(deps.markListed).toHaveBeenCalledWith("item-1");
    expect(deps.recordAttempt).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      "ebay",
      "live"
    );

    expect(result.publish).toMatchObject({
      mode: "sandbox",
      status: "live",
      listingId: "123",
    });
    expect(result.price.price).toBeGreaterThanOrEqual(result.price.floor);
  });
});

describe("runPipeline — dry run", () => {
  it("builds the payload but never touches eBay or the listing tables", async () => {
    const deps = fakeDeps({ publishMode: () => "dry_run" as const });
    const result = await runPipeline(input, deps);

    expect(deps.publishEbay).not.toHaveBeenCalled();
    expect(deps.recordListing).not.toHaveBeenCalled();
    expect(deps.markListed).not.toHaveBeenCalled();
    expect(deps.recordAttempt).not.toHaveBeenCalled();

    // draft + price still persisted — the item is real, only publish is dry
    expect(deps.createDraft).toHaveBeenCalled();
    expect(deps.recordPrice).toHaveBeenCalled();

    expect(result.publish.status).toBe("dry_run");
    if (result.publish.status === "dry_run") {
      expect(result.publish.payload.product.title).toContain("Sony");
      expect(result.publish.payload.product.imageUrls).toEqual([
        "https://cdn.example/p.jpg",
      ]);
    }
  });
});

describe("runPipeline — publish edge cases", () => {
  it("reports not_connected and records the attempt", async () => {
    const deps = fakeDeps({ getEbayConnection: vi.fn().mockResolvedValue(null) });
    const result = await runPipeline(input, deps);
    expect(result.publish.status).toBe("not_connected");
    expect(deps.recordAttempt).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      "ebay",
      "not_connected"
    );
  });

  it("records an error attempt when eBay publishing fails", async () => {
    const deps = fakeDeps({
      publishEbay: vi.fn().mockRejectedValue(new Error("eBay 500")),
    });
    const result = await runPipeline(input, deps);
    expect(result.publish).toMatchObject({ status: "error", message: "eBay 500" });
    expect(deps.recordAttempt).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      "ebay",
      "error",
      "eBay 500"
    );
  });

  it("still persists the draft when photo hosting fails, then routes to review", async () => {
    const deps = fakeDeps({
      hostPhoto: vi.fn().mockRejectedValue(new Error("bucket down")),
    });
    const result = await runPipeline(input, deps);
    expect(deps.createDraft).toHaveBeenCalledWith("user-1", expect.anything(), null);
    // no photo → the photo_quality guardrail holds the item for review
    expect(result.publish.status).toBe("review");
    if (result.publish.status === "review") {
      expect(result.publish.failures.map((f) => f.gate)).toContain("photo_quality");
    }
    expect(deps.publishEbay).not.toHaveBeenCalled();
  });
});

describe("runPipeline — guardrail routing", () => {
  it("parks a low-confidence identification in review instead of posting", async () => {
    const deps = fakeDeps({
      identify: vi.fn().mockResolvedValue({
        ...identified,
        confidence: 0.55,
      }),
    });
    const result = await runPipeline(input, deps);

    expect(result.publish.status).toBe("review");
    if (result.publish.status === "review") {
      expect(result.publish.failures).toEqual([
        expect.objectContaining({ gate: "confidence" }),
      ]);
    }
    // review is recorded on the item, and nothing was published anywhere
    expect(deps.setReview).toHaveBeenCalledWith("user-1", "item-1", [
      expect.objectContaining({ gate: "confidence" }),
    ]);
    expect(deps.publishEbay).not.toHaveBeenCalled();
    expect(deps.recordListing).not.toHaveBeenCalled();
    expect(deps.markListed).not.toHaveBeenCalled();

    // but the draft and its price decision still persisted
    expect(deps.createDraft).toHaveBeenCalled();
    expect(deps.recordPrice).toHaveBeenCalled();
  });

  it("holds VeRO-listed brands for a human authenticity check", async () => {
    const deps = fakeDeps({
      identify: vi.fn().mockResolvedValue({
        ...identified,
        extraction: {
          ...extraction,
          title: "Louis Vuitton Neverfull MM Tote",
          brand: "Louis Vuitton",
        },
      }),
    });
    const result = await runPipeline(input, deps);
    expect(result.publish.status).toBe("review");
    if (result.publish.status === "review") {
      expect(result.publish.failures.map((f) => f.gate)).toEqual(["vero_brand"]);
    }
  });

  it("does not let guardrail review block the sandbox happy path", async () => {
    const deps = fakeDeps();
    const result = await runPipeline(input, deps);
    expect(result.publish.status).toBe("live");
    expect(deps.setReview).not.toHaveBeenCalled();
  });
});

describe("resolvePublishMode", () => {
  it("is sandbox whenever EBAY_ENV says so, regardless of the live flag", () => {
    expect(resolvePublishMode({ EBAY_ENV: "sandbox" })).toBe("sandbox");
    expect(resolvePublishMode({ EBAY_ENV: "SANDBOX", PIPELINE_LIVE_PUBLISH: "true" })).toBe(
      "sandbox"
    );
  });

  it("requires the explicit opt-in flag for live production publishes", () => {
    expect(resolvePublishMode({})).toBe("dry_run");
    expect(resolvePublishMode({ EBAY_ENV: "production" })).toBe("dry_run");
    expect(resolvePublishMode({ PIPELINE_LIVE_PUBLISH: "false" })).toBe("dry_run");
    expect(resolvePublishMode({ PIPELINE_LIVE_PUBLISH: "true" })).toBe("live");
  });
});
