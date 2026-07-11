// ensureEbayLocation / setupEbayLocationOnConnect — the per-seller ship-from
// chain (docs/design/ship-from-location.md): meta cache → detect on eBay →
// create from profile → deprecated env fallback → actionable typed error.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PlatformConnection } from "./types";

vi.mock("@/lib/connections", () => ({
  saveConnection: vi.fn(async () => undefined),
  isExpired: () => false,
}));
vi.mock("@/lib/locations", () => ({
  getShipFromLocation: vi.fn(async () => null),
}));

import { saveConnection } from "@/lib/connections";
import { getShipFromLocation } from "@/lib/locations";
import {
  ensureEbayLocation,
  setupEbayLocationOnConnect,
  EbayShipFromMissingError,
} from "./ebay";

const conn = (meta: Record<string, string> = {}): PlatformConnection => ({
  userId: "user-1",
  platform: "ebay",
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  meta,
});

function jsonResponse(status: number, body: unknown): Response {
  // 204/205 must have no body per the fetch spec.
  if (status === 204 || status === 205) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Captures every eBay call so assertions can inspect method/path/body.
interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
  contentLanguage: string | null;
}

let calls: RecordedCall[];

function stubEbayApi(
  handler: (path: string, method: string) => Response
): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        path,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        contentLanguage: headers["Content-Language"] ?? null,
      });
      return handler(path, method);
    })
  );
}

beforeEach(() => {
  vi.mocked(saveConnection).mockClear();
  vi.mocked(getShipFromLocation).mockReset();
  vi.mocked(getShipFromLocation).mockResolvedValue(null);
  delete process.env.EBAY_POSTAL_CODE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureEbayLocation", () => {
  it("uses the cached meta key + marketplace without any network call", async () => {
    stubEbayApi(() => jsonResponse(500, {}));
    const result = await ensureEbayLocation(
      conn({ merchantLocationKey: "warehouse-1", marketplaceId: "EBAY_GB" })
    );
    expect(result).toMatchObject({
      merchantLocationKey: "warehouse-1",
      source: "meta",
    });
    expect(result.marketplace.id).toBe("EBAY_GB");
    expect(result.marketplace.currency).toBe("GBP");
    expect(calls).toHaveLength(0);
  });

  it("detects an existing seller location and caches it on the connection", async () => {
    stubEbayApi((path) => {
      if (path.startsWith("/sell/inventory/v1/location?")) {
        return jsonResponse(200, {
          locations: [
            {
              merchantLocationKey: "disabled-loc",
              merchantLocationStatus: "DISABLED",
              location: { address: { country: "DE" } },
            },
            {
              merchantLocationKey: "existing-loc",
              merchantLocationStatus: "ENABLED",
              location: { address: { country: "DE" } },
            },
          ],
        });
      }
      return jsonResponse(500, {});
    });

    const result = await ensureEbayLocation(conn());
    // Prefers the ENABLED location and derives the marketplace from its country.
    expect(result).toMatchObject({
      merchantLocationKey: "existing-loc",
      source: "detected",
    });
    expect(result.marketplace.id).toBe("EBAY_DE");
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          merchantLocationKey: "existing-loc",
          marketplaceId: "EBAY_DE",
          currency: "EUR",
        }),
      })
    );
    // The user is never asked anything — the profile isn't even read.
    expect(getShipFromLocation).not.toHaveBeenCalled();
  });

  it("creates a location from the stored ship-from profile (non-US format)", async () => {
    vi.mocked(getShipFromLocation).mockResolvedValue({
      country: "GB",
      postalCode: "SW1A 1AA",
      city: "London",
      stateOrProvince: null,
    });
    stubEbayApi((path, method) => {
      if (path.startsWith("/sell/inventory/v1/location?")) {
        return jsonResponse(200, { locations: [] });
      }
      if (
        method === "POST" &&
        path === "/sell/inventory/v1/location/snap-to-list-default"
      ) {
        return jsonResponse(204, {});
      }
      return jsonResponse(500, {});
    });

    const result = await ensureEbayLocation(conn());
    expect(result).toMatchObject({
      merchantLocationKey: "snap-to-list-default",
      source: "created",
    });
    expect(result.marketplace.id).toBe("EBAY_GB");

    const create = calls.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({
      location: {
        address: { country: "GB", postalCode: "SW1A 1AA", city: "London" },
      },
      merchantLocationStatus: "ENABLED",
    });
    // No stateOrProvince given → the key is omitted, not sent as null.
    const address = (
      create?.body as { location: { address: Record<string, string> } }
    ).location.address;
    expect("stateOrProvince" in address).toBe(false);
    expect(create?.contentLanguage).toBe("en-GB");
  });

  it("treats a 409 on create as already-existing and succeeds", async () => {
    vi.mocked(getShipFromLocation).mockResolvedValue({
      country: "AU",
      postalCode: "2000",
      city: null,
      stateOrProvince: null,
    });
    stubEbayApi((path, method) =>
      method === "POST"
        ? jsonResponse(409, {})
        : jsonResponse(200, { locations: [] })
    );
    const result = await ensureEbayLocation(conn());
    expect(result.source).toBe("created");
    expect(result.marketplace.id).toBe("EBAY_AU");
  });

  it("falls back to the deprecated EBAY_POSTAL_CODE env var (US-only) last", async () => {
    process.env.EBAY_POSTAL_CODE = "94103";
    stubEbayApi((path, method) =>
      method === "POST"
        ? jsonResponse(204, {})
        : jsonResponse(200, { locations: [] })
    );
    const result = await ensureEbayLocation(conn());
    expect(result.source).toBe("env_fallback");
    expect(result.marketplace.id).toBe("EBAY_US");
    const create = calls.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({
      location: { address: { country: "US", postalCode: "94103" } },
    });
  });

  it("throws the actionable typed error when there is nothing to go on", async () => {
    stubEbayApi(() => jsonResponse(200, { locations: [] }));
    const err = await ensureEbayLocation(conn()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EbayShipFromMissingError);
    // End-user safe: never mentions env vars.
    expect((err as Error).message).not.toMatch(/EBAY_POSTAL_CODE|env/i);
    expect((err as Error).message).toMatch(/ship-from/i);
  });

  it("uses a provided ship-from override without reading the profile", async () => {
    stubEbayApi((path, method) =>
      method === "POST"
        ? jsonResponse(204, {})
        : jsonResponse(200, { locations: [] })
    );
    const result = await ensureEbayLocation(conn(), {
      country: "DE",
      postalCode: "10115",
      city: "Berlin",
      stateOrProvince: null,
    });
    expect(result.source).toBe("created");
    expect(result.marketplace.id).toBe("EBAY_DE");
    expect(getShipFromLocation).not.toHaveBeenCalled();
  });
});

describe("setupEbayLocationOnConnect", () => {
  it("returns ready when a location was detected", async () => {
    stubEbayApi(() =>
      jsonResponse(200, {
        locations: [
          {
            merchantLocationKey: "loc-1",
            merchantLocationStatus: "ENABLED",
            location: { address: { country: "US" } },
          },
        ],
      })
    );
    expect(await setupEbayLocationOnConnect(conn())).toBe("ready");
  });

  it("returns ship_from_needed when there is no location and no profile", async () => {
    stubEbayApi(() => jsonResponse(200, { locations: [] }));
    expect(await setupEbayLocationOnConnect(conn())).toBe("ship_from_needed");
  });

  it("swallows infra errors — publish-time ensure retries the chain", async () => {
    vi.mocked(getShipFromLocation).mockRejectedValue(new Error("db down"));
    stubEbayApi(() => jsonResponse(200, { locations: [] }));
    expect(await setupEbayLocationOnConnect(conn())).toBe("ready");
  });
});
