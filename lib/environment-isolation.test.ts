// Environment isolation (live incident: sandbox + production share one
// Supabase DB; connecting the sandbox eBay seller OVERWROTE the production
// connection, and production then presented a sandbox refresh token to the
// production eBay client → 400 invalid_grant. Sandbox publish rows also
// landed where the production order-sync cron polls them).
//
// The property under test: every read/write of environment-scoped rows is
// PINNED to the process's own EBAY_ENV — a cross-environment token or
// listing is invisible, not just unused.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

const { recorder } = vi.hoisted(() => {
  const state = {
    calls: [] as RecordedCall[],
    result: { data: null as unknown, error: null as unknown },
  };
  function builder(table: string): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const method of [
      "select", "eq", "neq", "in", "upsert", "insert", "update", "delete",
      "order", "limit", "maybeSingle", "single",
    ]) {
      b[method] = (...args: unknown[]) => {
        state.calls.push({ table, method, args });
        return b;
      };
    }
    // Awaiting any point of the chain resolves the scripted result.
    b.then = (resolve: (v: unknown) => void) => resolve(state.result);
    return b;
  }
  return {
    recorder: {
      state,
      client: { from: (table: string) => builder(table) },
      reset(result: { data: unknown; error: unknown } = { data: null, error: null }) {
        state.calls = [];
        state.result = result;
      },
      eqCalls(table: string): Array<[string, unknown]> {
        return state.calls
          .filter((c) => c.table === table && c.method === "eq")
          .map((c) => [c.args[0] as string, c.args[1]]);
      },
    },
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => recorder.client),
}));

import { getConnection, saveConnection } from "./connections";
import { recordSoldEvent, findListingOwner } from "./sold-events";
import { openListingsFor } from "./order-sync";
import { currentEbayEnvironment } from "./ebay-env";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  recorder.reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("currentEbayEnvironment", () => {
  it("defaults to production — existing rows keep working", () => {
    expect(currentEbayEnvironment({})).toBe("production");
    expect(currentEbayEnvironment({ EBAY_ENV: "PRODUCTION" })).toBe("production");
  });
  it("is sandbox only for EBAY_ENV=sandbox, case-insensitively", () => {
    expect(currentEbayEnvironment({ EBAY_ENV: "sandbox" })).toBe("sandbox");
    expect(currentEbayEnvironment({ EBAY_ENV: "SANDBOX" })).toBe("sandbox");
    expect(currentEbayEnvironment({ EBAY_ENV: "staging" })).toBe("production");
  });
});

describe("connection reads/writes are environment-pinned", () => {
  it("a production process can only READ production tokens", async () => {
    await getConnection("user-1", "ebay");
    expect(recorder.eqCalls("platform_connections")).toContainEqual([
      "environment",
      "production",
    ]);
  });

  it("a sandbox process can only READ sandbox tokens — the production token is invisible", async () => {
    vi.stubEnv("EBAY_ENV", "sandbox");
    await getConnection("user-1", "ebay");
    expect(recorder.eqCalls("platform_connections")).toContainEqual([
      "environment",
      "sandbox",
    ]);
    expect(recorder.eqCalls("platform_connections")).not.toContainEqual([
      "environment",
      "production",
    ]);
  });

  it("saving a sandbox connection stamps environment and upserts on the 3-part key — it can never clobber production", async () => {
    vi.stubEnv("EBAY_ENV", "sandbox");
    await saveConnection({
      userId: "user-1",
      platform: "ebay",
      accessToken: "sandbox-token",
      refreshToken: "sandbox-refresh",
      expiresAt: null,
      meta: {},
    });
    const upsert = recorder.state.calls.find(
      (c) => c.table === "platform_connections" && c.method === "upsert"
    );
    expect(upsert).toBeDefined();
    expect((upsert?.args[0] as { environment: string }).environment).toBe(
      "sandbox"
    );
    expect(
      (upsert?.args[1] as { onConflict: string }).onConflict.split(",")
    ).toContain("environment");
  });
});

describe("order sync ignores foreign-environment rows", () => {
  it("production sync only sees production listings (the sandbox 110589875643 row is invisible)", async () => {
    recorder.reset({ data: [], error: null });
    await openListingsFor("user-1", "ebay");
    expect(recorder.eqCalls("marketplace_listings")).toContainEqual([
      "environment",
      "production",
    ]);
  });

  it("sandbox sync only sees sandbox listings", async () => {
    vi.stubEnv("EBAY_ENV", "sandbox");
    recorder.reset({ data: [], error: null });
    await openListingsFor("user-1", "ebay");
    expect(recorder.eqCalls("marketplace_listings")).toContainEqual([
      "environment",
      "sandbox",
    ]);
  });
});

describe("sold events are environment-scoped", () => {
  it("stamps the producing environment on intake", async () => {
    recorder.reset({ data: { id: 1 }, error: null });
    await recordSoldEvent({
      userId: "user-1",
      platform: "ebay",
      externalOrderId: "order-1",
      listingExternalId: "110589875643",
      sku: null,
      salePrice: 20,
      source: "poll",
    });
    const insert = recorder.state.calls.find(
      (c) => c.table === "sold_events" && c.method === "insert"
    );
    expect((insert?.args[0] as { environment: string }).environment).toBe(
      "production"
    );
  });

  it("attributes an order only to a listing from the SAME environment", async () => {
    await findListingOwner("ebay", "110589875643", null);
    expect(recorder.eqCalls("marketplace_listings")).toContainEqual([
      "environment",
      "production",
    ]);
  });
});
