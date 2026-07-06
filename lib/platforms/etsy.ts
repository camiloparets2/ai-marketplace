// Etsy integration: OAuth 2.0 with PKCE + live publishing via Open API v3.
//
// Publish chain (against the seller's connected shop):
//   1. resolve shop_id (cached in the connection at connect time)
//   2. pick a shipping profile (seller's first) and a taxonomy node
//      (keyword match against the extracted category)
//   3. create a DRAFT listing  →  4. upload the photo  →  5. activate
//
// Draft-first ordering matters: Etsy rejects activating a listing with no
// image, and activating is the moment the $0.20 listing fee is charged.
//
// Required env:
//   ETSY_API_KEY — the app keystring from etsy.com/developers
//   NEXT_PUBLIC_APP_URL — used to build the OAuth redirect URI
// Optional:
//   ETSY_WHO_MADE / ETSY_WHEN_MADE — Etsy requires these attribution fields;
//   defaults are "someone_else" / "2010_2019". Adjust for handmade shops.

import { createHash, randomBytes } from "crypto";
import type {
  ListingInput,
  PlatformConnection,
  UnownedConnection,
} from "@/lib/platforms/types";
import { composeListing } from "@/lib/platforms/compose";
import { saveConnection, isExpired } from "@/lib/connections";
import type { AcceptedMimeType } from "@/lib/image-validation";

const API_BASE = "https://api.etsy.com/v3";

function apiKey(): string {
  // ETSY_CLIENT_ID accepted as an alias — it's the name used in the launch
  // roadmap and (per that doc) already set in Vercel Production. Etsy v3
  // calls this value the "keystring"; it doubles as the OAuth client_id.
  const key = process.env.ETSY_API_KEY ?? process.env.ETSY_CLIENT_ID;
  if (!key) {
    throw new Error("Etsy is not configured. Set ETSY_API_KEY (or ETSY_CLIENT_ID).");
  }
  return key;
}

const OAUTH_SCOPES = "listings_w listings_r shops_r";

// ─── OAuth (PKCE) ─────────────────────────────────────────────────────────────

export function etsyRedirectUri(origin: string): string {
  // The redirect URI must match the one registered with Etsy byte-for-byte.
  // ETSY_REDIRECT_URI overrides the derived default so an already-registered
  // URI (e.g. /api/etsy/oauth/callback, aliased in next.config.ts) keeps
  // working without re-registering the app.
  return (
    process.env.ETSY_REDIRECT_URI ??
    `${process.env.NEXT_PUBLIC_APP_URL ?? origin}/api/oauth/etsy/callback`
  );
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function etsyAuthorizeUrl(
  state: string,
  challenge: string,
  origin: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: apiKey(),
    redirect_uri: etsyRedirectUri(origin),
    scope: OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://www.etsy.com/oauth/connect?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${API_BASE}/public/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Etsy token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

// Returns an unowned token bundle — the OAuth callback stamps the signed-in
// user's id before saving.
export async function etsyExchangeCode(
  code: string,
  verifier: string,
  origin: string
): Promise<UnownedConnection> {
  const token = await tokenRequest({
    grant_type: "authorization_code",
    client_id: apiKey(),
    redirect_uri: etsyRedirectUri(origin),
    code,
    code_verifier: verifier,
  });

  // Cache the seller's shop_id now so publishing doesn't re-resolve it.
  const shopId = await fetchShopId(token.access_token);

  return {
    platform: "etsy",
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    meta: shopId ? { shopId } : {},
  };
}

async function freshConnection(conn: PlatformConnection): Promise<PlatformConnection> {
  if (!isExpired(conn)) return conn;
  if (!conn.refreshToken) {
    throw new Error("Etsy session expired — reconnect your Etsy account.");
  }
  const token = await tokenRequest({
    grant_type: "refresh_token",
    client_id: apiKey(),
    refresh_token: conn.refreshToken,
  });
  const refreshed: PlatformConnection = {
    ...conn,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  await saveConnection(refreshed);
  return refreshed;
}

// ─── REST helper ──────────────────────────────────────────────────────────────

async function etsyFetch(
  accessToken: string,
  path: string,
  init: { method?: string; body?: BodyInit; json?: unknown } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey(),
    Authorization: `Bearer ${accessToken}`,
  };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  return fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });
}

async function etsyError(res: Response, step: string): Promise<Error> {
  const text = await res.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) detail = parsed.error;
  } catch {
    // keep raw text
  }
  return new Error(`Etsy ${step} failed (${res.status}): ${detail}`);
}

// ─── Shop / profiles / taxonomy ───────────────────────────────────────────────

async function fetchShopId(accessToken: string): Promise<string | null> {
  const res = await etsyFetch(accessToken, "/application/users/me");
  if (!res.ok) return null;
  const data = (await res.json()) as { shop_id?: number | null };
  return data.shop_id ? String(data.shop_id) : null;
}

async function resolveShopId(conn: PlatformConnection): Promise<string> {
  if (conn.meta.shopId) return conn.meta.shopId;
  const shopId = await fetchShopId(conn.accessToken);
  if (!shopId) {
    throw new Error(
      "Your Etsy account has no shop. Open a shop at etsy.com/sell before publishing."
    );
  }
  await saveConnection({ ...conn, meta: { ...conn.meta, shopId } });
  return shopId;
}

async function firstShippingProfileId(
  accessToken: string,
  shopId: string
): Promise<number> {
  const res = await etsyFetch(
    accessToken,
    `/application/shops/${shopId}/shipping-profiles`
  );
  if (!res.ok) throw await etsyError(res, "shipping profile lookup");
  const data = (await res.json()) as {
    results?: Array<{ shipping_profile_id: number }>;
  };
  const id = data.results?.[0]?.shipping_profile_id;
  if (!id) {
    throw new Error(
      "Your Etsy shop has no shipping profile. Create one in Etsy Shop Manager → Settings → Shipping, then retry."
    );
  }
  return id;
}

interface TaxonomyNode {
  id: number;
  name: string;
  children?: TaxonomyNode[];
}

// Etsy v3 has no taxonomy search endpoint, so we fetch the seller taxonomy
// tree and keyword-match the extracted category path + title against node
// names. Deeper nodes win ties (more specific categories list better).
export function matchTaxonomyNode(
  nodes: TaxonomyNode[],
  keywords: string[]
): number | null {
  const terms = keywords
    .flatMap((k) => k.toLowerCase().split(/[^a-z0-9]+/))
    .filter((t) => t.length > 2);

  let bestId: number | null = null;
  let bestScore = 0;

  function walk(node: TaxonomyNode, depth: number): void {
    const name = node.name.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += term.length;
    }
    if (score > 0) {
      // Depth is a tiebreaker only — a strong name match beats a deep weak one.
      const weighted = score * 10 + depth;
      if (weighted > bestScore) {
        bestScore = weighted;
        bestId = node.id;
      }
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  }

  for (const node of nodes) walk(node, 0);
  return bestId;
}

async function suggestTaxonomyId(
  accessToken: string,
  input: ListingInput
): Promise<number> {
  const res = await etsyFetch(accessToken, "/application/seller-taxonomy/nodes");
  if (!res.ok) throw await etsyError(res, "taxonomy lookup");
  const data = (await res.json()) as { results?: TaxonomyNode[] };

  const matched = matchTaxonomyNode(data.results ?? [], [
    input.category,
    input.title,
  ]);
  if (matched === null) {
    throw new Error(
      "Could not map this item to an Etsy category. Edit the category field and retry."
    );
  }
  return matched;
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export interface EtsyPublishResult {
  url: string;
  listingId: string;
  // Needed later to end the listing.
  shopId: string;
}

export async function publishToEtsy(
  connection: PlatformConnection,
  input: ListingInput,
  imageBytes: Uint8Array,
  mimeType: AcceptedMimeType
): Promise<EtsyPublishResult> {
  const conn = await freshConnection(connection);
  const shopId = await resolveShopId(conn);
  const composed = composeListing("etsy", input);

  const [shippingProfileId, taxonomyId] = await Promise.all([
    firstShippingProfileId(conn.accessToken, shopId),
    suggestTaxonomyId(conn.accessToken, input),
  ]);

  // 1. Draft listing
  const createRes = await etsyFetch(
    conn.accessToken,
    `/application/shops/${shopId}/listings`,
    {
      method: "POST",
      json: {
        quantity: 1,
        title: composed.title,
        description: composed.description,
        price: input.price,
        who_made: process.env.ETSY_WHO_MADE ?? "someone_else",
        when_made: process.env.ETSY_WHEN_MADE ?? "2010_2019",
        taxonomy_id: taxonomyId,
        shipping_profile_id: shippingProfileId,
        type: "physical",
        tags: composed.tags,
        state: "draft",
      },
    }
  );
  if (!createRes.ok) throw await etsyError(createRes, "listing creation");
  const listing = (await createRes.json()) as { listing_id: number };

  // 2. Photo upload (binary multipart — Etsy takes the file directly)
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(imageBytes)], { type: mimeType }),
    "photo.jpg"
  );
  const imageRes = await etsyFetch(
    conn.accessToken,
    `/application/shops/${shopId}/listings/${listing.listing_id}/images`,
    { method: "POST", body: form }
  );
  if (!imageRes.ok) throw await etsyError(imageRes, "photo upload");

  // 3. Activate — this is when Etsy charges the $0.20 listing fee.
  const activateRes = await etsyFetch(
    conn.accessToken,
    `/application/shops/${shopId}/listings/${listing.listing_id}`,
    { method: "PATCH", json: { state: "active" } }
  );
  if (!activateRes.ok) {
    // The draft with photo exists — surface that so the seller can finish in
    // Shop Manager instead of losing the work.
    const err = await etsyError(activateRes, "listing activation");
    throw new Error(
      `${err.message} A draft was saved — finish publishing it in Etsy Shop Manager.`
    );
  }

  return {
    url: `https://www.etsy.com/listing/${listing.listing_id}`,
    listingId: String(listing.listing_id),
    shopId,
  };
}

// Ends a live Etsy listing (sold elsewhere / manual delist) by deactivating
// it — the listing survives as inactive in Shop Manager, so the seller can
// relist without re-paying setup work.
export async function endEtsyListing(
  connection: PlatformConnection,
  shopId: string,
  listingId: string
): Promise<void> {
  const conn = await freshConnection(connection);
  const res = await etsyFetch(
    conn.accessToken,
    `/application/shops/${shopId}/listings/${listingId}`,
    { method: "PATCH", json: { state: "inactive" } }
  );
  // 404 → listing gone; already the end state we wanted.
  if (!res.ok && res.status !== 404) {
    throw await etsyError(res, "listing deactivation");
  }
}
