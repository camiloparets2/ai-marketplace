import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  getRedirectUrl,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server";
import { config, proxy } from "@/proxy";

describe("auth proxy", () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    if (previousUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (previousKey) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
    else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it.each([
    "/inventory",
    "/inventory/item-1",
    "/dashboard/settings",
    "/settings/ship-from",
  ])(
    "matches protected path %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
  );

  it.each(["/welcome", "/login", "/forgot-password", "/api/analyze"])(
    "does not match public or API path %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  );

  it("fails closed to the marketing page when root auth is unconfigured", async () => {
    const response = await proxy(new NextRequest("https://example.com/"));
    expect(getRedirectUrl(response)).toBe("https://example.com/welcome");
  });

  it("fails closed to login for a protected nested page", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/inventory/item-1")
    );
    const redirect = new URL(getRedirectUrl(response)!);
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("next")).toBe("/inventory/item-1");
    expect(redirect.searchParams.get("error")).toBe("auth_unavailable");
  });
});
