import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import {
  isValidShopDomain,
  verifyShopifyHmac,
  extractShopifySales,
} from "./shopify";

describe("isValidShopDomain", () => {
  it("accepts real myshopify domains", () => {
    expect(isValidShopDomain("my-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("store123.myshopify.com")).toBe(true);
  });

  it("rejects everything else (OAuth redirect safety)", () => {
    expect(isValidShopDomain("evil.example.com")).toBe(false);
    expect(isValidShopDomain("myshopify.com")).toBe(false);
    expect(isValidShopDomain("store.myshopify.com.evil.example")).toBe(false);
    expect(isValidShopDomain("https://store.myshopify.com")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
  });
});

describe("verifyShopifyHmac", () => {
  const secret = "test-secret";

  function sign(params: Record<string, string>): URLSearchParams {
    const sp = new URLSearchParams(params);
    const message = [...sp.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    sp.set("hmac", createHmac("sha256", secret).update(message).digest("hex"));
    return sp;
  }

  it("accepts a correctly signed callback", () => {
    const params = sign({
      code: "abc",
      shop: "my-store.myshopify.com",
      state: "xyz",
      timestamp: "1700000000",
    });
    expect(verifyShopifyHmac(params, secret)).toBe(true);
  });

  it("rejects tampered params", () => {
    const params = sign({ code: "abc", shop: "my-store.myshopify.com" });
    params.set("shop", "evil.myshopify.com");
    expect(verifyShopifyHmac(params, secret)).toBe(false);
  });

  it("rejects a missing hmac or wrong secret", () => {
    expect(verifyShopifyHmac(new URLSearchParams({ code: "x" }), secret)).toBe(
      false
    );
    const params = sign({ code: "abc" });
    expect(verifyShopifyHmac(params, "other-secret")).toBe(false);
  });
});

describe("extractShopifySales", () => {
  it("extracts one sale per line item with numeric prices", () => {
    const sales = extractShopifySales({
      orders: [
        {
          id: 42,
          line_items: [
            { product_id: 111, price: "25.00" },
            { product_id: null, price: "not-a-number" },
          ],
        },
      ],
    });
    expect(sales).toEqual([
      { orderId: "42", productId: "111", price: 25 },
      { orderId: "42", productId: null, price: null },
    ]);
  });

  it("returns empty on malformed payloads", () => {
    expect(extractShopifySales({})).toEqual([]);
    expect(extractShopifySales({ orders: null })).toEqual([]);
  });
});
