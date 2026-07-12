// ONE category resolver, ONE answer (sandbox bug: the breadcrumb said
// "Buckets & Tubs" while the specifics dropdown said "Trash Cans &
// Wastebaskets"). The aspects endpoint's resolution is PINNED on the draft
// (__ebayCategoryId in specs) and publishToEbay honors that key, so the
// breadcrumb, the dropdown, and the publish step can never disagree.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/connections", () => ({
  getConnection: vi.fn(),
}));
vi.mock("@/lib/inventory", () => ({
  getItemDetail: vi.fn(),
  mergeItemSpecs: vi.fn(async () => true),
}));
vi.mock("@/lib/platforms/ebay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platforms/ebay")>();
  return {
    ...actual,
    freshConnection: vi.fn(async (c: unknown) => c),
    getCategoryAspects: vi.fn(),
    suggestEbayCategories: vi.fn(),
  };
});

import { GET } from "./route";
import { getConnection } from "@/lib/connections";
import { getItemDetail, mergeItemSpecs } from "@/lib/inventory";
import { getCategoryAspects, suggestEbayCategories } from "@/lib/platforms/ebay";
import { EBAY_CATEGORY_SPEC_KEY } from "@/lib/ebay-aspects";
import type { AspectField } from "@/lib/ebay-aspects";

const conn = {
  userId: "user-1",
  platform: "ebay" as const,
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  meta: { marketplaceId: "EBAY_US" },
};

function item(specs: Record<string, string> = {}) {
  return {
    id: "item-1",
    title: "Galvanized bucket 5 gallon",
    brand: null,
    model: null,
    upc: null,
    condition: "Good",
    category: "Home & Garden > Buckets",
    specs,
    photo_url: null,
    price: 12,
    cost_of_goods: null,
    shipping_cost: 10.4,
    status: "draft" as const,
    review_reasons: [],
  };
}

const typeAspect: AspectField = {
  name: "Type",
  required: true,
  recommended: false,
  mode: "SELECTION_ONLY",
  dataType: "STRING",
  values: ["Bucket"],
};

function request(url = "https://app.example.com/api/inventory/item-1/aspects") {
  return new NextRequest(url);
}
const params = { params: Promise.resolve({ id: "item-1" }) };

beforeEach(() => {
  vi.mocked(getConnection).mockResolvedValue(conn);
  vi.mocked(getItemDetail).mockReset();
  vi.mocked(mergeItemSpecs).mockClear();
  vi.mocked(getCategoryAspects).mockReset();
  vi.mocked(suggestEbayCategories).mockResolvedValue([
    { categoryId: "111", categoryName: "Buckets & Tubs" },
    { categoryId: "222", categoryName: "Trash Cans & Wastebaskets" },
  ]);
});

describe("GET /api/inventory/[id]/aspects — one resolver, one answer", () => {
  it("PINS the first resolved leaf on the draft so publish uses the same category", async () => {
    vi.mocked(getItemDetail).mockResolvedValue(item());
    vi.mocked(getCategoryAspects).mockResolvedValue([typeAspect]);

    const res = await GET(request(), params);
    const body = (await res.json()) as {
      categoryId: string;
      categoryName: string;
    };
    expect(body.categoryId).toBe("111");
    expect(body.categoryName).toBe("Buckets & Tubs");
    expect(mergeItemSpecs).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      expect.objectContaining({ [EBAY_CATEGORY_SPEC_KEY]: "111" })
    );
  });

  it("prefers the draft's saved category and does NOT re-pin it", async () => {
    vi.mocked(getItemDetail).mockResolvedValue(
      item({ [EBAY_CATEGORY_SPEC_KEY]: "222" })
    );
    vi.mocked(getCategoryAspects).mockResolvedValue([typeAspect]);

    const res = await GET(request(), params);
    const body = (await res.json()) as { categoryId: string };
    // The saved answer wins — the dropdown and breadcrumb show what publish
    // will actually use, not a fresh (possibly different) suggestion.
    expect(body.categoryId).toBe("222");
    expect(mergeItemSpecs).not.toHaveBeenCalled();
  });

  it("re-pins when the saved category went stale, and says so", async () => {
    vi.mocked(getItemDetail).mockResolvedValue(
      item({ [EBAY_CATEGORY_SPEC_KEY]: "999" })
    );
    // 999 is no longer a leaf; 111 resolves.
    vi.mocked(getCategoryAspects).mockImplementation(
      async (_tok: string, _tree: string, categoryId: string) =>
        categoryId === "999" ? null : [typeAspect]
    );

    const res = await GET(request(), params);
    const body = (await res.json()) as {
      categoryId: string;
      staleCategory: boolean;
    };
    expect(body.categoryId).toBe("111");
    expect(body.staleCategory).toBe(true);
    expect(mergeItemSpecs).toHaveBeenCalledWith(
      "user-1",
      "item-1",
      expect.objectContaining({ [EBAY_CATEGORY_SPEC_KEY]: "111" })
    );
  });

  it("reports connected: false without an eBay connection — never a 5xx", async () => {
    vi.mocked(getItemDetail).mockResolvedValue(item());
    vi.mocked(getConnection).mockResolvedValue(null);

    const res = await GET(request(), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
    expect(mergeItemSpecs).not.toHaveBeenCalled();
  });
});
