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
//   EBAY_ENV                            — "production" (default) or "sandbox",
//                                          case-insensitive
// Optional policy overrides (otherwise the seller's first policy is used):
//   EBAY_FULFILLMENT_POLICY_ID, EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID
//
// DEPRECATED: EBAY_POSTAL_CODE — the old single global ship-from ZIP. The
// ship-from address is per-seller data now (docs/design/ship-from-location.md):
// detected from the seller's existing inventory locations at connect time, or
// created from their stored ship-from profile. The env var survives only as a
// last-resort local-dev fallback and assumes US.

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
import { getShipFromLocation } from "@/lib/locations";
import type { ShipFromLocation } from "@/lib/ship-from";
import {
  marketplaceForCountry,
  marketplaceById,
} from "@/lib/platforms/ebay-marketplaces";
import type { EbayMarketplace } from "@/lib/platforms/ebay-marketplaces";

// ─── Environment ──────────────────────────────────────────────────────────────

function isProduction(): boolean {
  // Production is the default now that the Production keyset is enabled;
  // only an explicit EBAY_ENV=sandbox (any casing) targets the sandbox.
  // Previously this required the exact string "PRODUCTION", so an unset or
  // lowercase value silently fell back to sandbox.
  return (process.env.EBAY_ENV ?? "production").toLowerCase() !== "sandbox";
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
  // Order polling (sale detection). Accounts connected before this scope was
  // added must reconnect for sales sync to work.
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function ebayAuthorizeUrl(state: string): string {
  const { clientId, ruName } = credentials();
  // Manual encoding: eBay documents %20-separated scopes; URLSearchParams
  // would emit "+", which OAuth servers may reject.
  const params: Array<[string, string]> = [
    ["client_id", clientId],
    ["response_type", "code"],
    ["redirect_uri", ruName],
    ["scope", OAUTH_SCOPES],
    ["state", state],
  ];
  const query = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${authBase()}/oauth2/authorize?${query}`;
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

// ─── Application token (client credentials) ───────────────────────────────────

export interface EbayAppToken {
  accessToken: string;
  // Epoch milliseconds when the token expires.
  expiresAt: number;
}

/**
 * Mints an application access token via the client-credentials grant against
 * the environment-appropriate token endpoint (production by default). App
 * tokens cover application-scope APIs (e.g. Taxonomy) that don't need a
 * seller's consent, and minting one is the cheapest end-to-end proof that
 * the keyset + secret are valid.
 */
export async function mintEbayAppToken(
  scope = "https://api.ebay.com/oauth/api_scope"
): Promise<EbayAppToken> {
  const token = await tokenRequest(
    new URLSearchParams({ grant_type: "client_credentials", scope })
  );
  return {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
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
  init: { method?: string; body?: unknown; contentLanguage?: string } = {}
): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // Required by Inventory API write calls; must match the seller's
      // marketplace (de-DE for EBAY_DE, en-GB for EBAY_GB, …).
      "Content-Language": init.contentLanguage ?? "en-US",
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

// ─── Merchant location (per-seller ship-from) ─────────────────────────────────
//
// docs/design/ship-from-location.md — order of preference:
//   1. merchantLocationKey cached in the connection meta (no network)
//   2. a location the seller already has on eBay (getInventoryLocations)
//   3. create one from the seller's stored ship-from profile
//   4. DEPRECATED local-dev fallback: EBAY_POSTAL_CODE (US-only)
//   5. EbayShipFromMissingError — the app maps it to an in-app prompt.

const MERCHANT_LOCATION_KEY = "snap-to-list-default";

// Thrown when the seller has no eBay inventory location and no stored
// ship-from address to create one from. The message is end-user safe;
// /api/publish attaches the settings link so the UI can render a CTA.
export class EbayShipFromMissingError extends Error {
  constructor() {
    super(
      "Add your ship-from location to publish on eBay — it takes 30 seconds in Settings."
    );
    this.name = "EbayShipFromMissingError";
  }
}

interface DetectedLocation {
  merchantLocationKey: string;
  country: string | null;
}

// Narrow view of a getInventoryLocations response.
interface LocationsPayload {
  locations?: Array<{
    merchantLocationKey?: string;
    merchantLocationStatus?: string;
    location?: { address?: { country?: string } };
  }> | null;
}

// Looks for a merchant location the seller already has — most established
// eBay sellers do, so this keeps them from ever seeing the ship-from form.
export async function detectEbayLocation(
  accessToken: string
): Promise<DetectedLocation | null> {
  const res = await ebayFetch(
    accessToken,
    "/sell/inventory/v1/location?limit=100"
  );
  if (!res.ok) return null;
  const data = (await res.json()) as LocationsPayload;
  const locations = (data.locations ?? []).filter(
    (l): l is { merchantLocationKey: string } & typeof l =>
      typeof l.merchantLocationKey === "string" && l.merchantLocationKey !== ""
  );
  if (locations.length === 0) return null;
  // Prefer an ENABLED location — offers can only reference enabled ones.
  const chosen =
    locations.find((l) => l.merchantLocationStatus === "ENABLED") ??
    locations[0];
  return {
    merchantLocationKey: chosen.merchantLocationKey,
    country: chosen.location?.address?.country ?? null,
  };
}

// Creates the seller's merchant location from a ship-from address. The key
// lives in the seller's own account namespace, so a constant is safe.
async function createEbayLocation(
  accessToken: string,
  shipFrom: ShipFromLocation,
  contentLanguage: string
): Promise<string> {
  const address: Record<string, string> = { country: shipFrom.country };
  if (shipFrom.postalCode) address.postalCode = shipFrom.postalCode;
  if (shipFrom.city) address.city = shipFrom.city;
  if (shipFrom.stateOrProvince)
    address.stateOrProvince = shipFrom.stateOrProvince;

  const created = await ebayFetch(
    accessToken,
    `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`,
    {
      method: "POST",
      contentLanguage,
      body: {
        location: { address },
        name: "Snap to List ship-from location",
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

export interface EnsuredEbayLocation {
  merchantLocationKey: string;
  marketplace: EbayMarketplace;
  // How the location was resolved — the OAuth callback uses this to decide
  // whether to send the user to the ship-from form.
  source: "meta" | "detected" | "created" | "env_fallback";
}

// Persist the resolved key + marketplace on the connection so subsequent
// publishes skip every lookup. Best-effort: a meta write failure must not
// fail a publish that already has everything it needs.
async function cacheLocationOnConnection(
  conn: PlatformConnection,
  merchantLocationKey: string,
  marketplace: EbayMarketplace
): Promise<void> {
  try {
    await saveConnection({
      ...conn,
      meta: {
        ...conn.meta,
        merchantLocationKey,
        marketplaceId: marketplace.id,
        currency: marketplace.currency,
      },
    });
  } catch (err) {
    console.warn("[ebay] failed to cache merchant location on connection", err);
  }
}

/**
 * Resolve the seller's merchant location + marketplace: cached meta first,
 * then detect on eBay, then create from the stored (or provided) ship-from
 * address. Throws EbayShipFromMissingError when there is nothing to go on.
 */
export async function ensureEbayLocation(
  conn: PlatformConnection,
  shipFromOverride: ShipFromLocation | null = null
): Promise<EnsuredEbayLocation> {
  const metaKey = conn.meta.merchantLocationKey;
  const metaMarketplace = marketplaceById(conn.meta.marketplaceId);
  if (metaKey && metaMarketplace) {
    return {
      merchantLocationKey: metaKey,
      marketplace: metaMarketplace,
      source: "meta",
    };
  }

  // The seller may already have a location from selling elsewhere — detect
  // before ever asking them anything.
  const detected = await detectEbayLocation(conn.accessToken);
  if (detected) {
    const marketplace =
      metaMarketplace ?? marketplaceForCountry(detected.country);
    await cacheLocationOnConnection(
      conn,
      detected.merchantLocationKey,
      marketplace
    );
    return {
      merchantLocationKey: detected.merchantLocationKey,
      marketplace,
      source: "detected",
    };
  }

  const shipFrom =
    shipFromOverride ?? (await getShipFromLocation(conn.userId));
  if (shipFrom) {
    const marketplace =
      metaMarketplace ?? marketplaceForCountry(shipFrom.country);
    const key = await createEbayLocation(
      conn.accessToken,
      shipFrom,
      marketplace.contentLanguage
    );
    await cacheLocationOnConnection(conn, key, marketplace);
    return { merchantLocationKey: key, marketplace, source: "created" };
  }

  // DEPRECATED: global env fallback from the single-seller era. US-only by
  // construction — kept so local dev keeps working, never a product answer.
  const envPostal = process.env.EBAY_POSTAL_CODE;
  if (envPostal) {
    console.warn(
      "[ebay] EBAY_POSTAL_CODE is deprecated — ship-from is per-user now; see docs/design/ship-from-location.md"
    );
    const marketplace = marketplaceForCountry("US");
    const key = await createEbayLocation(
      conn.accessToken,
      { country: "US", postalCode: envPostal, city: null, stateOrProvince: null },
      marketplace.contentLanguage
    );
    await cacheLocationOnConnection(conn, key, marketplace);
    return { merchantLocationKey: key, marketplace, source: "env_fallback" };
  }

  throw new EbayShipFromMissingError();
}

export type ConnectLocationStatus = "ready" | "ship_from_needed";

/**
 * Connect-time hook for the OAuth callback: detect (or create, when a
 * ship-from profile already exists) the seller's location so publishing
 * works immediately. "ship_from_needed" → the callback routes the user to
 * the ship-from form. Never throws on infra errors — publish-time
 * ensureEbayLocation retries the whole chain anyway.
 */
export async function setupEbayLocationOnConnect(
  conn: PlatformConnection
): Promise<ConnectLocationStatus> {
  try {
    await ensureEbayLocation(conn);
    return "ready";
  } catch (err) {
    if (err instanceof EbayShipFromMissingError) return "ship_from_needed";
    console.warn("[ebay] connect-time location setup failed; deferring", err);
    return "ready";
  }
}

// ─── Publish steps ────────────────────────────────────────────────────────────

async function suggestCategoryId(
  accessToken: string,
  title: string,
  categoryTreeId: string
): Promise<string> {
  const res = await ebayFetch(
    accessToken,
    `/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(title)}`
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

async function resolvePolicies(
  accessToken: string,
  marketplaceId: string
): Promise<PolicyIds> {
  async function firstPolicyId(
    kind: "fulfillment_policy" | "payment_policy" | "return_policy",
    envOverride: string | undefined,
    listKey: string,
    idKey: string
  ): Promise<string> {
    if (envOverride) return envOverride;
    const res = await ebayFetch(
      accessToken,
      `/sell/account/v1/${kind}?marketplace_id=${marketplaceId}`
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

export interface EbayPublishResult {
  url: string;
  listingId: string;
  // Needed later to end the listing (withdraw the offer).
  offerId: string;
  sku: string;
}

// Pure payload builders — exported so the pipeline's dry-run mode and unit
// tests can exercise the exact bodies eBay would receive without a network.

export interface EbayInventoryItemPayload {
  product: {
    title: string;
    description: string;
    aspects: Record<string, string[]>;
    imageUrls: string[];
    upc?: string[];
  };
  condition: string;
  availability: { shipToLocationAvailability: { quantity: number } };
}

export function buildEbayInventoryItemPayload(
  input: ListingInput,
  imageUrls: string[]
): EbayInventoryItemPayload {
  const composed = composeListing("ebay", input);

  // Item specifics (aspects) from brand/model/specs. eBay expects string arrays.
  const aspects: Record<string, string[]> = {};
  if (input.brand) aspects["Brand"] = [input.brand];
  if (input.model) aspects["Model"] = [input.model];
  for (const [key, value] of Object.entries(input.specs)) {
    aspects[key] = [value];
  }

  return {
    product: {
      title: composed.title,
      description: composed.description,
      aspects,
      // eBay accepts up to 12 picture URLs; our product cap is 8 (first =
      // hero). Defensive slice in case a caller ever exceeds it.
      imageUrls: imageUrls.slice(0, 12),
      ...(input.upc ? { upc: [input.upc] } : {}),
    },
    condition: EBAY_CONDITION_MAP[input.condition],
    availability: { shipToLocationAvailability: { quantity: 1 } },
  };
}

export interface EbayOfferPayload {
  sku: string;
  // The seller's marketplace (EBAY_US, EBAY_GB, EBAY_DE, …) — derived from
  // their account/country at connect time, never a global constant.
  marketplaceId: string;
  format: "FIXED_PRICE";
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  merchantLocationKey: string;
  pricingSummary: { price: { value: string; currency: string } };
  listingPolicies: PolicyIds;
}

export function buildEbayOfferPayload(
  input: ListingInput,
  sku: string,
  categoryId: string,
  merchantLocationKey: string,
  policies: PolicyIds,
  marketplace: EbayMarketplace
): EbayOfferPayload {
  return {
    sku,
    marketplaceId: marketplace.id,
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId,
    listingDescription: ebayHtmlDescription(input),
    merchantLocationKey,
    pricingSummary: {
      price: { value: input.price.toFixed(2), currency: marketplace.currency },
    },
    listingPolicies: policies,
  };
}

export async function publishToEbay(
  connection: PlatformConnection,
  input: ListingInput,
  imageUrls: string[]
): Promise<EbayPublishResult> {
  const conn = await freshConnection(connection);
  const composed = composeListing("ebay", input);

  // Unique SKU per publish keeps retries simple — no stale-offer reconciliation.
  const sku = `snap-${Date.now()}`;

  // Location first: it decides the marketplace (and with it the category
  // tree, currency, policies, and Content-Language) for everything below.
  const { merchantLocationKey, marketplace } = await ensureEbayLocation(conn);

  const [categoryId, policies] = await Promise.all([
    suggestCategoryId(conn.accessToken, composed.title, marketplace.categoryTreeId),
    resolvePolicies(conn.accessToken, marketplace.id),
  ]);

  const itemRes = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/inventory_item/${sku}`,
    {
      method: "PUT",
      contentLanguage: marketplace.contentLanguage,
      body: buildEbayInventoryItemPayload(input, imageUrls),
    }
  );
  if (!itemRes.ok) throw await ebayError(itemRes, "inventory item creation");

  const offerRes = await ebayFetch(conn.accessToken, "/sell/inventory/v1/offer", {
    method: "POST",
    contentLanguage: marketplace.contentLanguage,
    body: buildEbayOfferPayload(
      input,
      sku,
      categoryId,
      merchantLocationKey,
      policies,
      marketplace
    ),
  });
  if (!offerRes.ok) throw await ebayError(offerRes, "offer creation");
  const offer = (await offerRes.json()) as { offerId: string };

  const publishRes = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/offer/${offer.offerId}/publish`,
    { method: "POST", contentLanguage: marketplace.contentLanguage, body: {} }
  );
  if (!publishRes.ok) throw await ebayError(publishRes, "offer publish");
  const published = (await publishRes.json()) as { listingId: string };

  const url = isProduction()
    ? `https://www.ebay.com/itm/${published.listingId}`
    : `https://sandbox.ebay.com/itm/${published.listingId}`;
  return { url, listingId: published.listingId, offerId: offer.offerId, sku };
}

// ─── Sale detection (order polling) ───────────────────────────────────────────

export interface EbaySale {
  orderId: string;
  // eBay's listing id for the sold line item — matches our stored external_id.
  listingId: string | null;
  // Inventory API SKU — fallback match key (we set it at publish time).
  sku: string | null;
  price: number | null;
}

// Narrow view of a Sell Fulfillment getOrders response.
interface OrdersPayload {
  orders?: Array<{
    orderId?: string;
    orderPaymentStatus?: string;
    pricingSummary?: { total?: { value?: string } } | null;
    lineItems?: Array<{
      legacyItemId?: string | null;
      sku?: string | null;
      total?: { value?: string } | null;
    }> | null;
  }> | null;
}

function moneyValue(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return isFinite(parsed) ? parsed : null;
}

// Pure parse of getOrders — one sale per PAID line item.
export function extractEbaySales(payload: unknown): EbaySale[] {
  const orders = (payload as OrdersPayload).orders ?? [];
  const sales: EbaySale[] = [];
  for (const order of orders) {
    // Unpaid/failed orders don't end listings; skip until they become PAID.
    if (order.orderPaymentStatus && order.orderPaymentStatus !== "PAID") {
      continue;
    }
    for (const item of order.lineItems ?? []) {
      sales.push({
        orderId: order.orderId ?? "unknown",
        listingId: item.legacyItemId ?? null,
        sku: item.sku ?? null,
        price:
          moneyValue(item.total?.value) ??
          moneyValue(order.pricingSummary?.total?.value),
      });
    }
  }
  return sales;
}

// Fetch PAID sales created since `sinceIso` from the connected account.
export async function fetchEbaySales(
  connection: PlatformConnection,
  sinceIso: string
): Promise<EbaySale[]> {
  const conn = await freshConnection(connection);
  const filter = encodeURIComponent(`creationdate:[${sinceIso}..]`);
  const res = await ebayFetch(
    conn.accessToken,
    `/sell/fulfillment/v1/order?filter=${filter}&limit=50`
  );
  if (!res.ok) throw await ebayError(res, "order lookup");
  return extractEbaySales(await res.json());
}

// Ends a live eBay listing (sold elsewhere / manual delist) by withdrawing
// its offer. Treats "already ended" responses as success so retries and
// sold-elsewhere races stay idempotent.
export async function endEbayListing(
  connection: PlatformConnection,
  offerId: string
): Promise<void> {
  const conn = await freshConnection(connection);
  const res = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/offer/${offerId}/withdraw`,
    { method: "POST", body: {} }
  );
  // 404 → offer gone (already withdrawn or sold out); that's the end state
  // we wanted.
  if (!res.ok && res.status !== 404) {
    throw await ebayError(res, "listing withdrawal");
  }
}
