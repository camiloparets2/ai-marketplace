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
import { assertPhotosPubliclyReachable } from "@/lib/storage";
import { getShipFromLocation } from "@/lib/locations";
import type { ShipFromLocation } from "@/lib/ship-from";
import {
  marketplaceForCountry,
  marketplaceById,
  sellerRegistrationUrl,
  DEFAULT_EBAY_MARKETPLACE,
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

// Exported for the Notification API public-key lookup (ebay-signature.ts).
export function apiBase(): string {
  return isProduction()
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

function authBase(): string {
  return isProduction()
    ? "https://auth.ebay.com"
    : "https://auth.sandbox.ebay.com";
}

// The Identity API lives on the apiz host, not api.
function identityApiBase(): string {
  return isProduction()
    ? "https://apiz.ebay.com"
    : "https://apiz.sandbox.ebay.com";
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
  // Immutable seller identity (userId) — required so account-deletion
  // notifications can match and erase the right connection. Accounts
  // connected before this scope must reconnect (needsReconnect surfaces it).
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
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
// user's id before saving. The connection is refused outright when eBay's
// Identity API can't supply the immutable userId: without it, an
// account-deletion notification could never be matched to this connection
// (an eBay compliance requirement), so an unidentifiable connection is
// worse than no connection.
export async function ebayExchangeCode(code: string): Promise<UnownedConnection> {
  const { ruName } = credentials();
  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    })
  );

  const identityRes = await fetch(
    `${identityApiBase()}/commerce/identity/v1/user/`,
    {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
      },
    }
  );
  if (!identityRes.ok) {
    throw new Error(
      `eBay identity lookup failed (${identityRes.status}): ${await identityRes.text()}`
    );
  }
  const identity = (await identityRes.json()) as {
    userId?: string;
    username?: string;
    registrationMarketplaceId?: string;
  };
  if (!identity.userId) {
    throw new Error("eBay identity lookup did not return an immutable user id.");
  }

  return {
    platform: "ebay",
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Date.now() + token.expires_in * 1000,
    meta: {
      ebayUserId: identity.userId,
      ...(identity.username ? { ebayUsername: identity.username } : {}),
      ...(identity.registrationMarketplaceId
        ? { ebayRegistrationMarketplaceId: identity.registrationMarketplaceId }
        : {}),
    },
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

function parseEbayErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      errors?: Array<{ message?: string; longMessage?: string }>;
    };
    const first = parsed.errors?.[0];
    return first?.longMessage ?? first?.message ?? text;
  } catch {
    return text;
  }
}

async function ebayError(res: Response, step: string): Promise<Error> {
  const detail = parseEbayErrorDetail(await res.text());
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

// Persist resolved values on the connection so subsequent publishes skip
// every lookup. Mutates conn.meta in place FIRST so later cache writes in
// the same flow (e.g. location, then policies) never clobber each other.
// Best-effort: a meta write failure must not fail a publish that already
// has everything it needs.
async function cacheConnectionMeta(
  conn: PlatformConnection,
  patch: Record<string, string>
): Promise<void> {
  Object.assign(conn.meta, patch);
  try {
    await saveConnection(conn);
  } catch (err) {
    console.warn("[ebay] failed to cache connection meta", err);
  }
}

async function cacheLocationOnConnection(
  conn: PlatformConnection,
  merchantLocationKey: string,
  marketplace: EbayMarketplace
): Promise<void> {
  await cacheConnectionMeta(conn, {
    merchantLocationKey,
    marketplaceId: marketplace.id,
    currency: marketplace.currency,
  });
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
 * Connect-time hook for the OAuth callback: resolve the seller's ship-from
 * location AND business-policy readiness so publishing works immediately.
 * "ship_from_needed" → the callback routes the user to the ship-from form.
 * Everything else is best-effort — the /channels checklist surfaces what's
 * left, and publish-time ensure chains retry anyway.
 */
export async function setupEbayOnConnect(
  conn: PlatformConnection
): Promise<ConnectLocationStatus> {
  let marketplace: EbayMarketplace;
  try {
    ({ marketplace } = await ensureEbayLocation(conn));
  } catch (err) {
    if (err instanceof EbayShipFromMissingError) return "ship_from_needed";
    console.warn("[ebay] connect-time location setup failed; deferring", err);
    return "ready";
  }
  try {
    await ensureEbayPolicies(conn, marketplace);
  } catch (err) {
    // Not registered / program still activating / infra hiccup — all
    // surfaced by the checklist and retried at publish time.
    console.warn("[ebay] connect-time policy setup deferred", err);
  }
  return "ready";
}

// ─── Publish steps ────────────────────────────────────────────────────────────

export interface ResolvedCategory {
  categoryId: string;
  // Localized aspect names eBay REQUIRES for this category — publish blocks
  // until the item carries all of them.
  requiredAspects: string[];
  // Recommended / required-soon aspects — optimization prompts, not blockers.
  recommendedAspects: string[];
}

// Resolve the title to a CURRENT LEAF category and its aspect requirements.
// getItemAspectsForCategory doubles as the leaf check (eBay rejects non-leaf
// ids), so a non-leaf suggestion falls through to the next candidate. There
// is deliberately NO hardcoded fallback category — an unmappable item is the
// seller's call, never a silent mislisting.
async function resolveLeafCategory(
  accessToken: string,
  title: string,
  categoryTreeId: string
): Promise<ResolvedCategory> {
  const res = await ebayFetch(
    accessToken,
    `/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(title)}`
  );
  if (!res.ok) throw await ebayError(res, "category lookup");
  const data = (await res.json()) as {
    categorySuggestions?: Array<{ category: { categoryId: string } }>;
  };
  const candidates = (data.categorySuggestions ?? [])
    .map((sugg) => sugg.category.categoryId)
    .filter(Boolean)
    .slice(0, 3);
  if (candidates.length === 0) {
    throw new Error(
      "eBay could not suggest a category for this title. Edit the title and retry."
    );
  }

  for (const categoryId of candidates) {
    const aspectsRes = await ebayFetch(
      accessToken,
      `/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`
    );
    if (!aspectsRes.ok) {
      // Non-leaf (or retired) category id — try the next suggestion.
      continue;
    }
    const aspectData = (await aspectsRes.json()) as {
      aspects?: Array<{
        localizedAspectName?: string;
        aspectConstraint?: {
          aspectRequired?: boolean;
          aspectUsage?: string;
        };
      }>;
    };
    const requiredAspects: string[] = [];
    const recommendedAspects: string[] = [];
    for (const aspect of aspectData.aspects ?? []) {
      const name = aspect.localizedAspectName;
      if (!name) continue;
      if (aspect.aspectConstraint?.aspectRequired) requiredAspects.push(name);
      else if (aspect.aspectConstraint?.aspectUsage === "RECOMMENDED") {
        recommendedAspects.push(name);
      }
    }
    return { categoryId, requiredAspects, recommendedAspects };
  }

  throw new Error(
    "eBay's suggested categories for this title are not current leaf categories. Edit the title and retry."
  );
}

// Publish gate: every REQUIRED aspect must be present on the item. Loud and
// actionable — never a listing eBay would reject or bury.
export function missingRequiredAspects(
  required: string[],
  aspects: Record<string, string[]>
): string[] {
  const present = new Set(
    Object.keys(aspects).map((name) => name.toLowerCase())
  );
  return required.filter((name) => !present.has(name.toLowerCase()));
}

// ─── Seller readiness: business policies ──────────────────────────────────────
//
// Every offer must reference a fulfillment + payment + return policy, which
// a seller only has when they are (a) a registered seller with payouts set
// up, (b) opted into the Business Policies program, and (c) own one of each.
// This is ONBOARDING, not an error (docs/design/ebay-seller-readiness.md):
// ensureEbayPolicies mirrors the ship-from ensure chain — env overrides →
// meta cache → detect → remediate (opt-in / create defaults) → cache — so
// existing connections self-heal on their next publish.

export interface PolicyIds {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

export type EbaySellerSetupKind =
  | "not_registered"
  | "policies_pending"
  // Business policies are missing and creating them is a WRITE to the
  // seller's real eBay account — it requires their explicit confirmation of
  // the exact settings (Channels page), never a silent default.
  | "policies_unconfirmed";

// The states the app cannot silently fix. Messages are end-user safe:
// never a raw eBay status code, never config language.
export class EbaySellerSetupError extends Error {
  constructor(
    public readonly kind: EbaySellerSetupKind,
    // Seller-registration CTA on the seller's own marketplace (ebay.co.uk,
    // ebay.de, …). Callers that know the marketplace pass the derived URL;
    // the US entry is only the last-resort fallback.
    public readonly registrationUrl: string = EBAY_SELLER_REGISTRATION_URL
  ) {
    super(
      kind === "not_registered"
        ? "Your eBay account isn't set up for selling yet. Finish eBay's seller registration (identity + payout details), then publish again."
        : kind === "policies_unconfirmed"
          ? "Your eBay account needs business policies (shipping, payment, returns). Review and confirm the exact settings on the Channels page — nothing is written to your eBay account until you approve it."
          : "eBay is still enabling business policies on your account — this usually takes a few minutes. Try publishing again shortly."
    );
    this.name = "EbaySellerSetupError";
  }
}

// Fallback "Finish your eBay seller setup →" target when no marketplace is
// known yet; marketplace-aware paths use sellerRegistrationUrl(marketplace).
export const EBAY_SELLER_REGISTRATION_URL = sellerRegistrationUrl(
  DEFAULT_EBAY_MARKETPLACE
);

const POLICY_PROGRAM = "SELLING_POLICY_MANAGEMENT";

// eBay reports a non-registered seller as HTTP 400/403 with a message like
// "User is not eligible for Business Policy." on any policy/program call.
function isNotEligibleDetail(status: number, detail: string): boolean {
  return (status === 400 || status === 403) && /not eligible/i.test(detail);
}

// Like ebayError, but recognises the not-a-registered-seller signal and
// converts it to the typed onboarding error instead of a raw 400.
async function policyApiError(res: Response, step: string): Promise<Error> {
  const detail = parseEbayErrorDetail(await res.text());
  if (isNotEligibleDetail(res.status, detail)) {
    return new EbaySellerSetupError("not_registered");
  }
  return new Error(`eBay ${step} failed (${res.status}): ${detail}`);
}

interface PolicyKindSpec {
  kind: "fulfillment_policy" | "payment_policy" | "return_policy";
  listKey: string;
  idKey: keyof PolicyIds;
  envVar: string;
}

const POLICY_KINDS: ReadonlyArray<PolicyKindSpec> = [
  {
    kind: "fulfillment_policy",
    listKey: "fulfillmentPolicies",
    idKey: "fulfillmentPolicyId",
    envVar: "EBAY_FULFILLMENT_POLICY_ID",
  },
  {
    kind: "payment_policy",
    listKey: "paymentPolicies",
    idKey: "paymentPolicyId",
    envVar: "EBAY_PAYMENT_POLICY_ID",
  },
  {
    kind: "return_policy",
    listKey: "returnPolicies",
    idKey: "returnPolicyId",
    envVar: "EBAY_RETURN_POLICY_ID",
  },
];

async function isOptedIntoPolicies(accessToken: string): Promise<boolean> {
  const res = await ebayFetch(
    accessToken,
    "/sell/account/v1/program/get_opted_in_programs"
  );
  if (!res.ok) throw await policyApiError(res, "program lookup");
  const data = (await res.json()) as {
    programs?: Array<{ programType?: string }> | null;
  };
  return (data.programs ?? []).some((p) => p.programType === POLICY_PROGRAM);
}

async function optIntoPolicies(accessToken: string): Promise<void> {
  const res = await ebayFetch(accessToken, "/sell/account/v1/program/opt_in", {
    method: "POST",
    body: { programType: POLICY_PROGRAM },
  });
  if (!res.ok) throw await policyApiError(res, "business-policy opt-in");
}

// First policy of a kind for the marketplace (id + name, so the caller can
// recognise an app-created default); null when the seller has none
// (remediable) — the typed onboarding error when they can't have any.
async function listFirstPolicy(
  accessToken: string,
  spec: PolicyKindSpec,
  marketplaceId: string
): Promise<{ id: string; name: string | null } | null> {
  const res = await ebayFetch(
    accessToken,
    `/sell/account/v1/${spec.kind}?marketplace_id=${marketplaceId}`
  );
  if (!res.ok) throw await policyApiError(res, `${spec.kind} lookup`);
  const data = (await res.json()) as Record<
    string,
    Array<Record<string, string>> | undefined
  >;
  const first = data[spec.listKey]?.[0];
  const id = first?.[spec.idKey];
  return id ? { id, name: first?.name ?? null } : null;
}

// ── Default policy payloads (pure, exported for tests) ────────────────────────
//
// Conservative and later-editable: created only when the seller has none,
// named so they're recognisable in eBay's Business Policies manager, and
// never silently replacing anything the seller already set up.

const POLICY_CATEGORY_TYPES = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];

export interface EbayFulfillmentPolicyPayload {
  name: string;
  marketplaceId: string;
  categoryTypes: Array<{ name: string }>;
  handlingTime: { value: number; unit: "DAY" };
  shippingOptions?: Array<{
    optionType: "DOMESTIC";
    costType: "FLAT_RATE";
    shippingServices: Array<{
      sortOrder: number;
      shippingCarrierCode: string;
      shippingServiceCode: string;
      freeShipping: boolean;
    }>;
  }>;
}

// Name doubles as the marker that a detected policy is OUR default — the
// per-offer shipping-cost override only ever applies to this policy, never
// to something the seller configured themselves.
export const DEFAULT_FULFILLMENT_POLICY_NAME = "Snap to List default shipping";

export function buildDefaultFulfillmentPolicy(
  marketplace: EbayMarketplace
): EbayFulfillmentPolicyPayload {
  return {
    name: DEFAULT_FULFILLMENT_POLICY_NAME,
    marketplaceId: marketplace.id,
    categoryTypes: POLICY_CATEGORY_TYPES,
    handlingTime: { value: 3, unit: "DAY" },
    // Buyer-paid shipping, NEVER free by default: a silent free-shipping
    // policy written to a real seller's account makes the seller absorb an
    // uncosted bill (the $6.50 concrete-bag bug). The per-listing amount the
    // buyer pays comes from the offer's shippingCostOverrides (priority 1
    // matches this service's sortOrder). Free shipping stays a deliberate
    // opt-in on eBay's policy manager. Marketplaces without a vetted service
    // code get a policy with handling time only — the seller picks a service
    // on eBay.
    ...(marketplace.defaultShippingService
      ? {
          shippingOptions: [
            {
              optionType: "DOMESTIC" as const,
              costType: "FLAT_RATE" as const,
              shippingServices: [
                {
                  sortOrder: 1,
                  shippingCarrierCode:
                    marketplace.defaultShippingService.carrierCode,
                  shippingServiceCode:
                    marketplace.defaultShippingService.serviceCode,
                  freeShipping: false,
                },
              ],
            },
          ],
        }
      : {}),
  };
}

export interface EbayPaymentPolicyPayload {
  name: string;
  marketplaceId: string;
  categoryTypes: Array<{ name: string }>;
  immediatePay: boolean;
}

export function buildDefaultPaymentPolicy(
  marketplace: EbayMarketplace
): EbayPaymentPolicyPayload {
  // Managed payments (every active eBay seller today) needs no explicit
  // payment methods; immediate pay avoids unpaid-item chasing.
  return {
    name: "Snap to List default payments",
    marketplaceId: marketplace.id,
    categoryTypes: POLICY_CATEGORY_TYPES,
    immediatePay: true,
  };
}

export interface EbayReturnPolicyPayload {
  name: string;
  marketplaceId: string;
  categoryTypes: Array<{ name: string }>;
  returnsAccepted: boolean;
  returnPeriod: { value: number; unit: "DAY" };
  returnShippingCostPayer: "BUYER" | "SELLER";
  refundMethod: "MONEY_BACK";
}

export function buildDefaultReturnPolicy(
  marketplace: EbayMarketplace
): EbayReturnPolicyPayload {
  // 30-day returns, buyer pays return shipping — the documented default
  // (shown in the checklist copy), editable in eBay's policy manager.
  return {
    name: "Snap to List default returns",
    marketplaceId: marketplace.id,
    categoryTypes: POLICY_CATEGORY_TYPES,
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: "DAY" },
    returnShippingCostPayer: "BUYER",
    refundMethod: "MONEY_BACK",
  };
}

// Human-readable summary of the EXACT settings the app would create — what
// the seller confirms on the Channels page before anything is written to
// their eBay account. Keep in lockstep with the builders above.
export interface DefaultPolicyDescription {
  fulfillment: string;
  payment: string;
  returns: string;
}

export function describeDefaultPolicies(
  marketplace: EbayMarketplace
): DefaultPolicyDescription {
  const f = buildDefaultFulfillmentPolicy(marketplace);
  const service = marketplace.defaultShippingService;
  return {
    fulfillment: service
      ? `Shipping: ${f.handlingTime.value}-business-day handling; domestic ${service.carrierCode} ${service.serviceCode}; the buyer pays each listing's shipping estimate (never free shipping by default).`
      : `Shipping: ${f.handlingTime.value}-business-day handling; no shipping service is set — you pick one in eBay's Business Policies manager before publishing.`,
    payment: "Payment: eBay managed payments, immediate payment required.",
    returns:
      "Returns: 30-day returns accepted; buyer pays return shipping; money-back refund.",
  };
}

function defaultPolicyPayload(
  spec: PolicyKindSpec,
  marketplace: EbayMarketplace
): unknown {
  switch (spec.kind) {
    case "fulfillment_policy":
      return buildDefaultFulfillmentPolicy(marketplace);
    case "payment_policy":
      return buildDefaultPaymentPolicy(marketplace);
    case "return_policy":
      return buildDefaultReturnPolicy(marketplace);
  }
}

async function createPolicy(
  accessToken: string,
  spec: PolicyKindSpec,
  marketplace: EbayMarketplace
): Promise<string> {
  const res = await ebayFetch(accessToken, `/sell/account/v1/${spec.kind}`, {
    method: "POST",
    contentLanguage: marketplace.contentLanguage,
    body: defaultPolicyPayload(spec, marketplace),
  });
  if (res.ok) {
    const data = (await res.json()) as Record<string, string | undefined>;
    const id = data[spec.idKey];
    if (id) return id;
    throw new Error(`eBay ${spec.kind} creation returned no policy id`);
  }
  // Duplicate-name race (concurrent publish already created it) → adopt the
  // existing policy instead of failing.
  const err = await policyApiError(res, `${spec.kind} creation`);
  const existing = await listFirstPolicy(
    accessToken,
    spec,
    marketplace.id
  ).catch(() => null);
  if (existing) return existing.id;
  throw err;
}

/**
 * Resolve the three business-policy ids for the seller's marketplace:
 * env overrides → connection meta → detect on eBay → remediate (opt into
 * the program / create conservative defaults) → cache in meta.
 *
 * Throws EbaySellerSetupError("not_registered") when eBay reports the
 * account ineligible (seller registration incomplete — the one state the
 * app cannot fix), or ("policies_pending") when eligibility flips mid-flow
 * right after our opt-in (program still activating).
 */
export async function ensureEbayPolicies(
  conn: PlatformConnection,
  marketplace: EbayMarketplace,
  // Opting into the policy program and creating policies are WRITES to the
  // seller's real eBay account. They happen ONLY when the seller explicitly
  // confirmed the exact settings (POST /api/channels/ebay-readiness with
  // confirm: true). Detection/adoption of existing policies is always safe.
  opts: { mayCreate?: boolean } = {}
): Promise<PolicyIds> {
  const mayCreate = opts.mayCreate ?? false;
  const resolved: Partial<PolicyIds> = {};
  for (const spec of POLICY_KINDS) {
    const fromEnv = process.env[spec.envVar];
    const value = fromEnv ?? conn.meta[spec.idKey];
    if (value) resolved[spec.idKey] = value;
  }
  if (
    resolved.fulfillmentPolicyId &&
    resolved.paymentPolicyId &&
    resolved.returnPolicyId
  ) {
    return resolved as PolicyIds;
  }

  const token = (await freshConnection(conn)).accessToken;

  // Detect + remediate. A "not eligible" AFTER a successful opt-in means the
  // program is still activating, not that the seller is unregistered.
  let justOptedIn = false;
  // Determined only when the fulfillment policy is resolved on eBay this
  // run: is it OUR default (created now, or name-matched)? null → the id
  // came from env/meta and any prior determination in meta stands.
  let fulfillmentIsAppDefault: boolean | null = null;
  try {
    if (!(await isOptedIntoPolicies(token))) {
      if (!mayCreate) {
        throw new EbaySellerSetupError(
          "policies_unconfirmed",
          sellerRegistrationUrl(marketplace)
        );
      }
      await optIntoPolicies(token);
      justOptedIn = true;
    }

    for (const spec of POLICY_KINDS) {
      if (resolved[spec.idKey]) continue;
      const existing = await listFirstPolicy(token, spec, marketplace.id);
      if (!existing && !mayCreate) {
        throw new EbaySellerSetupError(
          "policies_unconfirmed",
          sellerRegistrationUrl(marketplace)
        );
      }
      const id = existing?.id ?? (await createPolicy(token, spec, marketplace));
      resolved[spec.idKey] = id;
      if (spec.kind === "fulfillment_policy") {
        fulfillmentIsAppDefault = existing
          ? existing.name === DEFAULT_FULFILLMENT_POLICY_NAME
          : true;
      }
    }
  } catch (err) {
    if (err instanceof EbaySellerSetupError) {
      // Re-raise with the seller's own marketplace registration URL (and the
      // policies_pending reclassification right after a successful opt-in).
      const kind =
        justOptedIn && err.kind === "not_registered"
          ? "policies_pending"
          : err.kind;
      throw new EbaySellerSetupError(kind, sellerRegistrationUrl(marketplace));
    }
    throw err;
  }

  const ids = resolved as PolicyIds;

  // Cache only detection/creation results — env overrides stay in env so a
  // config change keeps winning.
  const patch: Record<string, string> = {};
  for (const spec of POLICY_KINDS) {
    if (!process.env[spec.envVar]) patch[spec.idKey] = ids[spec.idKey];
  }
  if (fulfillmentIsAppDefault !== null) {
    patch.fulfillmentPolicyAppDefault = String(fulfillmentIsAppDefault);
  }
  if (Object.keys(patch).length > 0) {
    await cacheConnectionMeta(conn, patch);
  }

  return ids;
}

// Whether the fulfillment policy the next offer will use is the app-created
// default. Only then may the offer attach a shippingCostOverrides entry — a
// policy the seller configured (or pinned via env) is theirs and is never
// overridden. Meta is written by ensureEbayPolicies; absent → false (assume
// seller-owned, the safe direction).
export function fulfillmentPolicyIsAppDefault(
  conn: PlatformConnection
): boolean {
  if (process.env.EBAY_FULFILLMENT_POLICY_ID) return false;
  return conn.meta.fulfillmentPolicyAppDefault === "true";
}

// ── Detect-only readiness (channels checklist) ────────────────────────────────
//
// GET /api/channels must never mutate the seller's eBay account from a page
// view, so this probes without opting in or creating anything. Remediation
// runs at connect time, at publish time, and via the explicit
// "Set up automatically" action (POST /api/channels/ebay-readiness).

export type EbayPoliciesReadiness =
  | "ready"
  | "missing" // fixable automatically (not opted in / no policies yet)
  | "not_registered" // seller must finish eBay registration — CTA
  | "unknown"; // probe failed; publish-time chain will retry

export interface EbayReadiness {
  shipFrom: boolean;
  policies: EbayPoliciesReadiness;
  // Seller-registration CTA target on the seller's own marketplace
  // (ebay.co.uk, ebay.de, …) — used when policies === "not_registered".
  registrationUrl: string;
  // The EXACT settings "Set up my policies" would create — shown for the
  // seller's confirmation before any write to their eBay account.
  proposedPolicies: DefaultPolicyDescription;
}

export async function detectEbayReadiness(
  conn: PlatformConnection
): Promise<EbayReadiness> {
  let marketplace = marketplaceById(conn.meta.marketplaceId);
  const regUrl = (): string =>
    sellerRegistrationUrl(marketplace ?? DEFAULT_EBAY_MARKETPLACE);
  const proposed = (): DefaultPolicyDescription =>
    describeDefaultPolicies(marketplace ?? DEFAULT_EBAY_MARKETPLACE);

  let token: string;
  try {
    token = (await freshConnection(conn)).accessToken;
  } catch {
    return {
      shipFrom: Boolean(conn.meta.merchantLocationKey),
      policies: "unknown",
      registrationUrl: regUrl(),
      proposedPolicies: proposed(),
    };
  }

  let shipFrom = Boolean(conn.meta.merchantLocationKey);
  if (!shipFrom) {
    try {
      const detected = await detectEbayLocation(token);
      if (detected) {
        shipFrom = true;
        marketplace ??= marketplaceForCountry(detected.country);
      }
    } catch {
      // leave shipFrom false — the settings page handles it
    }
  }

  const envReady = POLICY_KINDS.every(
    (spec) => process.env[spec.envVar] ?? conn.meta[spec.idKey]
  );
  if (envReady) {
    return {
      shipFrom,
      policies: "ready",
      registrationUrl: regUrl(),
      proposedPolicies: proposed(),
    };
  }

  const marketplaceId = (marketplace ?? marketplaceForCountry(null)).id;
  try {
    if (!(await isOptedIntoPolicies(token))) {
      return {
        shipFrom,
        policies: "missing",
        registrationUrl: regUrl(),
        proposedPolicies: proposed(),
      };
    }
    for (const spec of POLICY_KINDS) {
      if (process.env[spec.envVar] ?? conn.meta[spec.idKey]) continue;
      if ((await listFirstPolicy(token, spec, marketplaceId)) === null) {
        return {
          shipFrom,
          policies: "missing",
          registrationUrl: regUrl(),
          proposedPolicies: proposed(),
        };
      }
    }
    return {
      shipFrom,
      policies: "ready",
      registrationUrl: regUrl(),
      proposedPolicies: proposed(),
    };
  } catch (err) {
    if (err instanceof EbaySellerSetupError && err.kind === "not_registered") {
      return {
        shipFrom,
        policies: "not_registered",
        registrationUrl: regUrl(),
        proposedPolicies: proposed(),
      };
    }
    return {
      shipFrom,
      policies: "unknown",
      registrationUrl: regUrl(),
      proposedPolicies: proposed(),
    };
  }
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
      // eBay allows up to 24 pictures on a single-SKU listing; our product
      // cap is 8 (first = the seller's own hero photo — originals always
      // lead). Defensive slice in case a caller ever exceeds it. There is no
      // stock-photo fallback anywhere: only the seller's uploads are listed.
      imageUrls: imageUrls.slice(0, 24),
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
  // Good 'Til Cancelled — the only duration the Inventory API accepts for
  // fixed-price listings; explicit per eBay's publishing requirements.
  listingDuration: "GTC";
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  merchantLocationKey: string;
  pricingSummary: { price: { value: string; currency: string } };
  listingPolicies: PolicyIds & {
    // Per-listing buyer-paid shipping charge, matched by priority to the
    // sortOrder-1 service in the app-default fulfillment policy. Present
    // ONLY when that policy is in use — never over a seller's own policy.
    shippingCostOverrides?: Array<{
      priority: number;
      shippingServiceType: "DOMESTIC";
      shippingCost: { value: string; currency: string };
    }>;
  };
}

export function buildEbayOfferPayload(
  input: ListingInput,
  sku: string,
  categoryId: string,
  merchantLocationKey: string,
  policies: PolicyIds,
  marketplace: EbayMarketplace,
  // True when the fulfillment policy is the app-created default (see
  // fulfillmentPolicyIsAppDefault) — that policy carries no shipping amount
  // of its own, so the offer MUST supply the buyer-paid charge.
  usesAppDefaultFulfillment: boolean
): EbayOfferPayload {
  const needsShippingCharge =
    usesAppDefaultFulfillment &&
    marketplace.defaultShippingService !== undefined;
  if (needsShippingCharge && input.shippingCost === null) {
    // The money rule, enforced at the last exit: without a shipping cost the
    // default policy would charge the buyer $0.00 — free shipping through
    // the back door. Guardrails/UI should have caught this earlier.
    throw new Error(
      "This item has no shipping cost estimate — add one before publishing to eBay."
    );
  }
  return {
    sku,
    marketplaceId: marketplace.id,
    format: "FIXED_PRICE",
    listingDuration: "GTC",
    availableQuantity: 1,
    categoryId,
    listingDescription: ebayHtmlDescription(input),
    merchantLocationKey,
    pricingSummary: {
      price: { value: input.price.toFixed(2), currency: marketplace.currency },
    },
    listingPolicies: {
      ...policies,
      ...(needsShippingCharge && input.shippingCost !== null
        ? {
            shippingCostOverrides: [
              {
                priority: 1,
                shippingServiceType: "DOMESTIC" as const,
                shippingCost: {
                  value: input.shippingCost.toFixed(2),
                  currency: marketplace.currency,
                },
              },
            ],
          }
        : {}),
    },
  };
}

// Deterministic SKU per inventory item: retries of the same item reuse the
// same eBay inventory item + offer instead of minting a timestamped SKU per
// try (which duplicated listings on retry). ≤50 chars per eBay's SKU limit.
export function ebaySkuForItem(inventoryItemId: string): string {
  return `snap-${inventoryItemId}`;
}

// The seller's existing offer for this SKU on this marketplace, if any.
async function findOfferBySku(
  accessToken: string,
  sku: string,
  marketplaceId: string
): Promise<{ offerId: string; status: string; listingId: string | null } | null> {
  const res = await ebayFetch(
    accessToken,
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`
  );
  // eBay 404s when the SKU has no offers at all.
  if (res.status === 404) return null;
  if (!res.ok) throw await ebayError(res, "offer lookup");
  const data = (await res.json()) as {
    offers?: Array<{
      offerId?: string;
      marketplaceId?: string;
      status?: string;
      listing?: { listingId?: string } | null;
    }>;
  };
  const offer = (data.offers ?? []).find(
    (o) => o.marketplaceId === marketplaceId && o.offerId
  );
  if (!offer?.offerId) return null;
  return {
    offerId: offer.offerId,
    status: offer.status ?? "UNPUBLISHED",
    listingId: offer.listing?.listingId ?? null,
  };
}

export async function publishToEbay(
  connection: PlatformConnection,
  input: ListingInput,
  imageUrls: string[],
  // Deterministic, item-derived SKU (ebaySkuForItem). Passing the same SKU
  // on retry is what makes the publish idempotent.
  sku: string
): Promise<EbayPublishResult> {
  // Preflight BEFORE any eBay write: a photo URL that isn't publicly
  // fetchable (private storage bucket → 400/403/503) must fail the publish
  // with the fix, never produce a photoless or rejected listing.
  await assertPhotosPubliclyReachable(imageUrls);

  const conn = await freshConnection(connection);
  const composed = composeListing("ebay", input);

  // Location first: it decides the marketplace (and with it the category
  // tree, currency, policies, and Content-Language) for everything below.
  const { merchantLocationKey, marketplace } = await ensureEbayLocation(conn);

  const [resolvedCategory, policies] = await Promise.all([
    resolveLeafCategory(conn.accessToken, composed.title, marketplace.categoryTreeId),
    // Seller-readiness ensure chain: cached ids, else detect / opt-in /
    // create defaults. Throws the typed onboarding error when the seller
    // hasn't finished eBay registration.
    ensureEbayPolicies(conn, marketplace),
  ]);
  const categoryId = resolvedCategory.categoryId;

  const itemPayload = buildEbayInventoryItemPayload(input, imageUrls);
  const missing = missingRequiredAspects(
    resolvedCategory.requiredAspects,
    itemPayload.product.aspects
  );
  if (missing.length > 0) {
    throw new Error(
      `eBay requires these item specifics for this category: ${missing.join(", ")}. Add them to the item details and publish again.`
    );
  }
  if (resolvedCategory.recommendedAspects.length > 0) {
    // Optimization prompt (not a blocker) — surfaced in logs today; the
    // draft-edit UI picks these up in a follow-up.
    console.info(
      `[ebay] recommended aspects for category ${categoryId}: ${resolvedCategory.recommendedAspects.join(", ")}`
    );
  }

  const itemRes = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/inventory_item/${sku}`,
    {
      // PUT by SKU is an idempotent upsert — a retry updates in place.
      method: "PUT",
      contentLanguage: marketplace.contentLanguage,
      body: itemPayload,
    }
  );
  if (!itemRes.ok) throw await ebayError(itemRes, "inventory item creation");

  const offerPayload = buildEbayOfferPayload(
    input,
    sku,
    categoryId,
    merchantLocationKey,
    policies,
    marketplace,
    // Meta was just refreshed by ensureEbayPolicies above.
    fulfillmentPolicyIsAppDefault(conn)
  );

  // Retry safety: reuse this item's existing offer instead of creating a
  // duplicate. Already published → return the live listing as-is.
  let offerId: string;
  const existing = await findOfferBySku(conn.accessToken, sku, marketplace.id);
  if (existing) {
    if (existing.status === "PUBLISHED" && existing.listingId) {
      return {
        url: listingUrl(existing.listingId),
        listingId: existing.listingId,
        offerId: existing.offerId,
        sku,
      };
    }
    const updateRes = await ebayFetch(
      conn.accessToken,
      `/sell/inventory/v1/offer/${existing.offerId}`,
      {
        method: "PUT",
        contentLanguage: marketplace.contentLanguage,
        body: offerPayload,
      }
    );
    if (!updateRes.ok) throw await ebayError(updateRes, "offer update");
    offerId = existing.offerId;
  } else {
    const offerRes = await ebayFetch(conn.accessToken, "/sell/inventory/v1/offer", {
      method: "POST",
      contentLanguage: marketplace.contentLanguage,
      body: offerPayload,
    });
    if (offerRes.ok) {
      offerId = ((await offerRes.json()) as { offerId: string }).offerId;
    } else {
      // Concurrent-create race: the offer now exists — adopt it.
      const err = await ebayError(offerRes, "offer creation");
      const raced = await findOfferBySku(conn.accessToken, sku, marketplace.id).catch(
        () => null
      );
      if (!raced) throw err;
      offerId = raced.offerId;
    }
  }

  const publishRes = await ebayFetch(
    conn.accessToken,
    `/sell/inventory/v1/offer/${offerId}/publish`,
    { method: "POST", contentLanguage: marketplace.contentLanguage, body: {} }
  );
  if (!publishRes.ok) {
    const err = await ebayError(publishRes, "offer publish");
    // The app-default policy on a marketplace with no vetted service code is
    // created with handling time only (shippingOptions is optional at policy
    // creation, but eBay refuses to PUBLISH an offer whose policy has no
    // shipping service). Give the seller the fix instead of the raw eBay 400.
    if (
      fulfillmentPolicyIsAppDefault(conn) &&
      !marketplace.defaultShippingService &&
      /shipping service/i.test(err.message)
    ) {
      throw new Error(
        `Your eBay shipping policy has no shipping service yet — open eBay's Business Policies manager, add a service to "${DEFAULT_FULFILLMENT_POLICY_NAME}", then publish again.`
      );
    }
    throw err;
  }
  const published = (await publishRes.json()) as { listingId: string };
  return {
    url: listingUrl(published.listingId),
    listingId: published.listingId,
    offerId,
    sku,
  };
}

function listingUrl(listingId: string): string {
  return isProduction()
    ? `https://www.ebay.com/itm/${listingId}`
    : `https://sandbox.ebay.com/itm/${listingId}`;
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
