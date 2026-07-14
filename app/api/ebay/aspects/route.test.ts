// Title-only aspects resolution for the SNAP screen (first-run dead end:
// the required-specifics form existed only on /inventory/[id], so the
// primary path could reach Publish missing a required aspect and fail at
// eBay). Same shared resolver as the edit view — one resolver, one answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/connections", () => ({
  getConnection: vi.fn(),
}));
vi.mock("@/lib/platforms/ebay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platforms/ebay")>();
  return {
    ...actual,
    freshConnection: vi.fn(async (c: unknown) => c),
    getCategoryAspects: vi.fn(),
    getAllowedConditionIds: vi.fn(async () => ["1000", "1500", "3000"]),
    suggestEbayCategories: vi.fn(),
  };
});

import { GET } from "./route";
import { getConnection } from "@/lib/connections";
import { getCategoryAspects, suggestEbayCategories } from "@/lib/platforms/ebay";
import type { AspectField } from "@/lib/ebay-aspects";

const conn = {
  userId: "user-1",
  platform: "ebay" as const,
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  meta: { marketplaceId: "EBAY_US" },
};

const brandAspect: AspectField = {
  name: "Brand",
  required: true,
  recommended: false,
  mode: "FREE_TEXT",
  dataType: "STRING",
  values: [],
};

beforeEach(() => {
  vi.mocked(getConnection).mockResolvedValue(conn);
  vi.mocked(getCategoryAspects).mockReset();
  vi.mocked(suggestEbayCategories).mockResolvedValue([
    { categoryId: "888", categoryName: "Mugs" },
  ]);
});

describe("GET /api/ebay/aspects — snap-screen requirements from the title", () => {
  it("resolves the leaf + required aspects + legal conditions from a title alone", async () => {
    vi.mocked(getCategoryAspects).mockResolvedValue([brandAspect]);
    const res = await GET(
      new NextRequest("https://app.example.com/api/ebay/aspects?title=Ceramic%20mug")
    );
    const body = (await res.json()) as {
      connected: boolean;
      categoryId: string;
      aspects: AspectField[];
      allowedConditionIds: string[];
    };
    expect(body.connected).toBe(true);
    expect(body.categoryId).toBe("888");
    expect(body.aspects[0]).toMatchObject({ name: "Brand", required: true });
    expect(body.allowedConditionIds).toEqual(["1000", "1500", "3000"]);
  });

  it("prefers an explicitly requested category over the suggestion", async () => {
    vi.mocked(getCategoryAspects).mockResolvedValue([brandAspect]);
    const res = await GET(
      new NextRequest(
        "https://app.example.com/api/ebay/aspects?title=Ceramic%20mug&category=777"
      )
    );
    const body = (await res.json()) as { categoryId: string };
    expect(body.categoryId).toBe("777");
  });

  it("400s without a title", async () => {
    const res = await GET(new NextRequest("https://app.example.com/api/ebay/aspects"));
    expect(res.status).toBe(400);
  });

  it("degrades to connected: false without an eBay connection — never blocks the snap flow", async () => {
    vi.mocked(getConnection).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("https://app.example.com/api/ebay/aspects?title=Ceramic%20mug")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; aspects: unknown[] };
    expect(body.connected).toBe(false);
    expect(body.aspects).toEqual([]);
  });
});
