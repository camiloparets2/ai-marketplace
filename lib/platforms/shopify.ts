// Shopify integration: OAuth (authorization code grant with HMAC-verified
// callbacks) + live product publishing via the REST Admin API.
//
// Unlike eBay/Etsy, Shopify tokens are offline tokens — they don't expire
// and there's no refresh flow. The connected shop domain lives in the
// connection's meta.
//
// Required env (create a Shopify app at partners.shopify.com or a custom app):
//   SHOPIFY_API_KEY    — the app's client id
//   SHOPIFY_API_SECRET — the app's client secret (also signs callback HMACs)
// The app's allowed redirection URL must be
//   {NEXT_PUBLIC_APP_URL}/api/oauth/shopify/callback

import { createHmac, timingSafeEqual } from "crypto";
import type { ListingInput, PlatformConnection } from "@/lib/platforms/types";
import type { UnownedConnection } from "@/lib/platforms/types";
import { composeListing, ebayHtmlDescription } from "@/lib/platforms/compose";

const API_VERSION = "2025-07";
const OAUTH_SCOPES = "write_products,read_orders";

function credentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      "Shopify is not configured. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET."
    );
  }
  return { apiKey, apiSecret };
}

// ─── Shop domain validation ───────────────────────────────────────────────────

// Only *.myshopify.com domains are valid OAuth targets; anything else could
// redirect the consent flow (and our client id) to an attacker's host.
export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function shopifyAuthorizeUrl(
  shop: string,
  state: string,
  origin: string
): string {
  if (!isValidShopDomain(shop)) {
    throw new Error(
      "Enter your .myshopify.com domain, e.g. my-store.myshopify.com"
    );
  }
  const { apiKey } = credentials();
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? origin}/api/oauth/shopify/callback`;
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: OAUTH_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

// Shopify signs callback query strings: hmac = HMAC-SHA256(secret, all params
// except `hmac`, sorted, k=v joined with &). Reject anything unsigned.
export function verifyShopifyHmac(
  params: URLSearchParams,
  secret: string
): boolean {
  const received = params.get("hmac");
  if (!received) return false;

  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const computed = createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function shopifyExchangeCode(
  shop: string,
  code: string
): Promise<UnownedConnection> {
  const { apiKey, apiSecret } = credentials();
  if (!isValidShopDomain(shop)) throw new Error("Invalid shop domain");

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token request failed (${res.status}): ${await res.text()}`);
  }
  const token = (await res.json()) as { access_token: string };

  return {
    platform: "shopify",
    accessToken: token.access_token,
    refreshToken: null,
    expiresAt: null, // offline token — never expires
    meta: { shop },
  };
}

// ─── REST helper ──────────────────────────────────────────────────────────────

function shopDomain(conn: PlatformConnection): string {
  const shop = conn.meta.shop;
  if (!shop || !isValidShopDomain(shop)) {
    throw new Error("Shopify connection has no shop domain — reconnect your store.");
  }
  return shop;
}

async function shopifyFetch(
  conn: PlatformConnection,
  path: string,
  init: { method?: string; json?: unknown } = {}
): Promise<Response> {
  return fetch(`https://${shopDomain(conn)}/admin/api/${API_VERSION}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "X-Shopify-Access-Token": conn.accessToken,
      "Content-Type": "application/json",
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
}

async function shopifyError(res: Response, step: string): Promise<Error> {
  const text = await res.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { errors?: unknown };
    if (parsed.errors) detail = JSON.stringify(parsed.errors);
  } catch {
    // keep raw text
  }
  return new Error(`Shopify ${step} failed (${res.status}): ${detail}`);
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export interface ShopifyPublishResult {
  url: string;
  productId: string;
  shop: string;
}

export async function publishToShopify(
  connection: PlatformConnection,
  input: ListingInput,
  imageBase64: string
): Promise<ShopifyPublishResult> {
  const composed = composeListing("shopify", input);
  const shop = shopDomain(connection);

  const res = await shopifyFetch(connection, "/products.json", {
    method: "POST",
    json: {
      product: {
        title: composed.title,
        // Same structured HTML body the eBay listing uses — generic markup.
        body_html: ebayHtmlDescription(input),
        ...(input.brand ? { vendor: input.brand } : {}),
        status: "active",
        tags: input.category,
        variants: [
          {
            price: input.price.toFixed(2),
            sku: `snap-${Date.now()}`,
          },
        ],
        // Shopify accepts the photo inline as base64 — no hosting needed.
        images: [{ attachment: imageBase64 }],
      },
    },
  });
  if (!res.ok) throw await shopifyError(res, "product creation");

  const data = (await res.json()) as {
    product: { id: number; handle: string };
  };
  return {
    url: `https://${shop}/products/${data.product.handle}`,
    productId: String(data.product.id),
    shop,
  };
}

// Ends a live Shopify product (sold elsewhere / manual delist) by moving it
// to draft — hidden from the storefront but kept for easy relisting.
export async function endShopifyListing(
  connection: PlatformConnection,
  productId: string
): Promise<void> {
  const res = await shopifyFetch(connection, `/products/${productId}.json`, {
    method: "PUT",
    json: { product: { id: Number(productId), status: "draft" } },
  });
  // 404 → product deleted; already the end state we wanted.
  if (!res.ok && res.status !== 404) {
    throw await shopifyError(res, "product unpublish");
  }
}

// ─── Sale detection (order polling) ───────────────────────────────────────────

export interface ShopifySale {
  orderId: string;
  // Shopify product id of the sold line item — matches our stored external_id.
  productId: string | null;
  price: number | null;
}

// Narrow view of the REST orders payload.
interface OrdersPayload {
  orders?: Array<{
    id?: number;
    line_items?: Array<{
      product_id?: number | null;
      price?: string | null;
    }> | null;
  }> | null;
}

// Pure parse — one sale per line item. The fetch already filters to paid.
export function extractShopifySales(payload: unknown): ShopifySale[] {
  const orders = (payload as OrdersPayload).orders ?? [];
  const sales: ShopifySale[] = [];
  for (const order of orders) {
    for (const item of order.line_items ?? []) {
      const price = item.price ? Number(item.price) : NaN;
      sales.push({
        orderId: String(order.id ?? "unknown"),
        productId: item.product_id ? String(item.product_id) : null,
        price: isFinite(price) ? price : null,
      });
    }
  }
  return sales;
}

// Fetch paid orders created since `sinceIso` from the connected store.
export async function fetchShopifySales(
  connection: PlatformConnection,
  sinceIso: string
): Promise<ShopifySale[]> {
  const params = new URLSearchParams({
    status: "any",
    financial_status: "paid",
    created_at_min: sinceIso,
    limit: "50",
    fields: "id,line_items",
  });
  const res = await shopifyFetch(connection, `/orders.json?${params.toString()}`);
  if (!res.ok) throw await shopifyError(res, "order lookup");
  return extractShopifySales(await res.json());
}
