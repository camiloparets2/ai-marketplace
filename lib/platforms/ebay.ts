// eBay integration: OAuth (authorization code grant) + live publishing via the
// Sell Inventory API.
//
// Publish chain (all against the seller's connected account):
//   1. ensure a merchant location exists (required by offers)
//   2. suggest a category ID from the title (Taxonomy API)
//   3. PUT inventory item (title, description, aspects, image URL, condition)
//   4. resolve the seller's business policies (fulfillment / payment / return)
//   5. POST offer  →  6. POST offer/{id}/publish  →  listing URL
//
// Required env:
//   EBAY_CLIENT_ID / EBAY_CLIENT_SECRET — keyset from developer.ebay.com
//   EBAY_RU_NAME                        — the RuName tied to the OAuth redirect
//   EBAY_ENV                            — "SANDBOX" (default) or "PRODUCTION"
//   EBAY_POSTAL_CODE                    — ship-from ZIP for the merchant location
// Optional policy overrides (otherwise the seller's first policy is used):
//   EBAY_FULFILLMENT_POLICY_ID, EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID

import type {
  ListingInput,
  PlatformConnection,
  UnownedConnection,
} from "@/lib/platforms/types";
import {
  composeListing,
  ebayHtmlDescription,
  EBAY_CONDITION_MAP,
} from "@/lib/platforms/compose";
import { saveConnection, isExpired } from "@/lib/connections";

// ─── Environment ──────────────────────────────────────────────────────────────

function isProduction(): boolean {
  return process.env.EBAY_ENV === "PRODUCTION";
}

function apiBase(): string {
  return isProduction()
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

function authBase(): string {
  return isProduction()
    ? "https://auth.ebay.com"
    : "https://auth.sandbox.ebay.com";
}

function credentials(): { clientId: string; clientSecret: string; ruName: string } {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  // EBAY_RUNAME accepted as an alias — it's the spelling used in the launch
  // roadmap and (per that doc) already set in Vercel Production.
  const ruName = process.env.EBAY_RU_NAME ?? process.env.EBAY_RUNAME;
  if (!clientId || !clientSecret || !ruName) {
    throw new Error(
      "eBay is not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME."
    );
  }
  return { clientId, clientSecret, ruName };
}

const OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
].join(" ");

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function ebayAuthorizeUrl(state: string): string {
  const { clientId, ruName } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: ruName,
    scope: OAUTH_SCOPES,
    state,
  });
  return `${authBase()}/oauth2/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(`${apiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`eBay token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

// Returns an unowned token bundle — the OAuth callback stamps the signed-in
// user's id before saving.
export async function ebayExchangeCode(code: string): Promise<UnownedConnection> {
  const { ruName } = credentials();
  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    })
  );
  return {
    platform: "ebay",
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Date.now() + token.expires_in * 1000,
    meta: {},
  };
}

async function freshConnection(conn: PlatformConnection): Promise<PlatformConnection> {
  if (!isExpired(conn)) return conn;
  if (!conn.refreshToken) {
    throw new Error("eBay session expired — reconnect your eBay account.");
  }
  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
      scope: OAUTH_SCOPES,
    })
  );
  const refreshed: PlatformConnection = {
    ...conn,
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  await saveConnection(refreshed);
  return refreshed;
}

// ─── REST helper ──────────────────────────────────────────────────────────────

async function ebayFetch(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // Required by Inventory API write calls.
      "Content-Language": "en-US",
      Accept: "application/json",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function ebayError(res: Response, step: string): Promise<Error> {
  const text = await res.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as {
      errors?: Array<{ message?: string; longMessage?: string }>;
    };
    const first = parsed.errors?.[0];
    detail = first?.longMessage ?? first?.message ?? text;
  } catch {
    // keep raw text
  }
  return new Error(`eBay ${step} failed (${res.status}): ${detail}`);
}

// ─── Publish steps ────────────────────────────────────────────────────────────

const MERCHANT_LOCATION_KEY = "snap-to-list-default";

async function ensureMerchantLocation(accessToken: string): Promise<string> {
  const existing = await ebayFetch(
    accessToken,
    "/sell/inventory/v1/location?limit=1"
  );
  if (existing.ok) {
    const data = (await existing.json()) as {
      locations?: Array<{ merchantLocationKey: string }>;
    };
    const key = data.locations?.[0]?.merchantLocationKey;
    if (key) return key;
  }

  const postalCode = process.env.EBAY_POSTAL_CODE;
  if (!postalCode) {
    throw new Error(
      "No eBay inventory location found. Set EBAY_POSTAL_CODE so one can be created."
    );
  }

  const created = await ebayFetch(
    accessToken,
    `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`,
    {
      method: "POST",
      body: {
        location: { address: { postalCode, country: "US" } },
        name: "Snap to List default location",
        merchantLocationStatus: "ENABLED",
        locationTypes: ["WAREHOUSE"],
      },
    }
  );
  // 409 → already exists (race with a previous publish); safe to reuse.
  if (!created.ok && created.status !== 409) {
    throw await ebayError(created, "location setup");
  }
  return MERCHANT_LOCATION_KEY;
}

async function suggestCategoryId(
  accessToken: string,
  title: string
): Promise<string> {
  const res = await ebayFetch(
    accessToken,
    `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title)}`
  );
  if (!res.ok) throw await ebayError(res, "category lookup");
  const data = (await res.json()) as {
    categorySuggestions?: Array<{ category: { categoryId: string } }>;
  };
  const id = data.categorySuggestions?.[0]?.category.categoryId;
  if (!id) {
    throw new Error(
      "eBay could not suggest a category for this title. Edit the title and retry."
    );
  }
  return id;
}

interface PolicyIds {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

async function resolvePolicies(accessToken: string): Promise<PolicyIds> {
  async function firstPolicyId(
    kind: "fulfillment_policy" | "payment_policy" | "return_policy",
    envOverride: string | undefined,
    listKey: string,
    idKey: string
  ): Promise<string> {
    if (envOverride) return envOverride;
    const res = await ebayFetch(
      accessToken,
      `/sell/account/v1/${kind}?marketplace_id=EBAY_US`
    );
    if (!res.ok) throw await ebayError(res, `${kind} lookup`);
    const data = (await res.json()) as Record<
      string,
      Array<Record<string, string>>
    >;
    const id = data[listKey]?.[0]?.[idKey];
    if (!id) {
      throw new Error(
        `Your eBay account has no ${kind.replace("_", " ")}. Create business policies at ebay.com → Account → Business policies, then retry.`
      );
    }
    return id;
  }

  const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] =
    await Promise.all([
      firstPolicyId(
        "fulfillment_policy",
        process.env.EBAY_FULFILLMENT_POLICY_ID,
        "fulfillmentPolicies",
        "fulfillmentPolicyId"
      ),
      firstPolicyId(
        "payment_policy",
        process.env.EBAY_PAYMENT_POLICY_ID,
        "paymentPolicies",
        "paymentPolicyId"
      ),
      firstPolicyId(
        "return_policy",
        process.env.EBAY_RETURN_POLICY_ID,
        "returnPolicies",
        "returnPolicyId"
      ),
    ]);

  return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export async function publishToEbay(
  connection: PlatformConnection,
  input: ListingInput,
  imageUrl: string
): Promise<string> {
  const conn = await freshConnection(connection);
  const composed = composeListing("ebay", input);

  // Unique SKU per publish keeps retries simple — no stale-offer reconciliation.
  const sku = `snap-${Date.now()}`;

  const [merchantLocationKey, categoryId, policies] = await Promise.all([
    ensureMerchantLocation(conn.accessToken),
    suggestCategoryId(conn.accessToken, composed.title),
    resolvePolicies(conn.accessToken),
  ]);

  // Item specifics (aspects) from brand/model/specs. eBay expects string arrays.
  const aspects: Record<string, string[]> = {};
  if (input.brand) aspects["Brand"] = [input.brand];
  if (input.model) aspects["Model"] = [input.model];
  for (const [key, value] of Object.entries(input.specs)) {
    aspects[key] = [value];
  }

  const itemRes = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/inventory_item/${sku}`,
    {
      method: "PUT",
      body: {
        product: {
          title: composed.title,
          description: composed.description,
          aspects,
          imageUrls: [imageUrl],
          ...(input.upc ? { upc: [input.upc] } : {}),
        },
        condition: EBAY_CONDITION_MAP[input.condition],
        availability: { shipToLocationAvailability: { quantity: 1 } },
      },
    }
  );
  if (!itemRes.ok) throw await ebayError(itemRes, "inventory item creation");

  const offerRes = await ebayFetch(conn.accessToken, "/sell/inventory/v1/offer", {
    method: "POST",
    body: {
      sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId,
      listingDescription: ebayHtmlDescription(input),
      merchantLocationKey,
      pricingSummary: {
        price: { value: input.price.toFixed(2), currency: "USD" },
      },
      listingPolicies: policies,
    },
  });
  if (!offerRes.ok) throw await ebayError(offerRes, "offer creation");
  const offer = (await offerRes.json()) as { offerId: string };

  const publishRes = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/offer/${offer.offerId}/publish`,
    { method: "POST", body: {} }
  );
  if (!publishRes.ok) throw await ebayError(publishRes, "offer publish");
  const published = (await publishRes.json()) as { listingId: string };

  return isProduction()
    ? `https://www.ebay.com/itm/${published.listingId}`
    : `https://sandbox.ebay.com/itm/${published.listingId}`;
}
