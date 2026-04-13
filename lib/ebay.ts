// ─── eBay API Service ─────────────────────────────────────────────────────────
// Handles token refresh and the 3-step Inventory API flow:
//   1. PUT  /sell/inventory/v1/inventory_item/{sku}  — create/update item
//   2. POST /sell/inventory/v1/offer                 — create offer with price
//   3. POST /sell/inventory/v1/offer/{offerId}/publish — push listing live
//
// All functions are fail-loud (throw on error) so callers can catch + toast.

import { supabaseAdmin } from "@/lib/supabase";

const EBAY_API_BASE = "https://api.ebay.com";
const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";

// ─── Token management ─────────────────────────────────────────────────────────

/**
 * Returns a valid access token for a seller, refreshing it first if expired.
 * Throws if no eBay connection exists or refresh fails.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const { data: profile, error } = await supabaseAdmin
    .from("seller_profiles")
    .select("ebay_access_token, ebay_refresh_token, ebay_token_expiry")
    .eq("id", userId)
    .single();

  if (error || !profile?.ebay_access_token) {
    throw new Error("eBay account not connected. Please connect your eBay account first.");
  }

  const isExpired =
    !profile.ebay_token_expiry ||
    new Date(profile.ebay_token_expiry) <= new Date(Date.now() + 60_000); // 1-min buffer

  if (!isExpired) {
    return profile.ebay_access_token;
  }

  if (!profile.ebay_refresh_token) {
    throw new Error("eBay token expired and no refresh token available. Please reconnect.");
  }

  console.log("[ebay] Access token expired — refreshing for user:", userId);
  return refreshAccessToken(userId, profile.ebay_refresh_token);
}

async function refreshAccessToken(
  userId: string,
  refreshToken: string
): Promise<string> {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("eBay credentials not configured on server.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: [
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
      ].join(" "),
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    console.error("[ebay] Token refresh failed:", res.status, body);
    throw new Error("Failed to refresh eBay token. Please reconnect your account.");
  }

  const data = await res.json() as {
    access_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  const { error: dbError } = await supabaseAdmin
    .from("seller_profiles")
    .update({
      ebay_access_token: data.access_token,
      ebay_token_expiry: expiresAt,
    })
    .eq("id", userId);

  if (dbError) {
    console.error("[ebay] Failed to persist refreshed token:", dbError.message);
    // Return the new token anyway — DB failure shouldn't block the current call
  }

  console.log("[ebay] Token refreshed successfully for user:", userId);
  return data.access_token;
}

// ─── eBay API helper ──────────────────────────────────────────────────────────

async function ebayFetch(
  accessToken: string,
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${EBAY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    console.error("[ebay] API call failed:", method, path, res.status, data);
  }

  return { ok: res.ok, status: res.status, data };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EbayListingInput {
  listingId: string;    // used as SKU
  title: string;
  brand: string | null;
  description: string;
  condition: string;    // e.g. "Good"
  price: number;
  stockImageUrl: string | null;
  category: string;
}

// eBay condition enum IDs (subset of the most common)
const CONDITION_ID_MAP: Record<string, number> = {
  New: 1000,
  "Like New": 1500,
  Good: 3000,
  Fair: 5000,
  Poor: 7000,
};

// ─── 3-Step Inventory Flow ───────────────────────────────────────────────────

/**
 * Posts a listing to eBay using the Inventory API (3-step flow).
 * Returns the eBay listing URL on success, throws on failure.
 */
export async function postListingToEbay(
  userId: string,
  input: EbayListingInput
): Promise<string> {
  const accessToken = await getValidAccessToken(userId);
  const sku = `snap2list-${input.listingId}`;

  // Step 1: Create / update inventory item
  console.log("[ebay] Step 1 — creating inventory item, SKU:", sku);
  const itemPayload = {
    product: {
      title: input.title,
      brand: input.brand ?? "Unbranded",
      description: input.description,
      ...(input.stockImageUrl
        ? { imageUrls: [input.stockImageUrl] }
        : {}),
    },
    condition: String(
      CONDITION_ID_MAP[input.condition] ?? CONDITION_ID_MAP["Good"]
    ),
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
      },
    },
  };

  const itemRes = await ebayFetch(
    accessToken,
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    "PUT",
    itemPayload
  );

  if (!itemRes.ok) {
    throw new Error(
      `eBay Step 1 failed (inventory item): HTTP ${itemRes.status}`
    );
  }

  // Step 2: Create offer
  console.log("[ebay] Step 2 — creating offer for SKU:", sku);
  const offerPayload = {
    sku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    listingPolicies: {},
    pricingSummary: {
      price: {
        value: input.price.toFixed(2),
        currency: "USD",
      },
    },
    categoryId: "9355", // Electronics > Other (generic fallback)
  };

  const offerRes = await ebayFetch(
    accessToken,
    "/sell/inventory/v1/offer",
    "POST",
    offerPayload
  );

  if (!offerRes.ok) {
    throw new Error(
      `eBay Step 2 failed (create offer): HTTP ${offerRes.status}`
    );
  }

  const offerId = (offerRes.data as { offerId?: string })?.offerId;
  if (!offerId) {
    throw new Error("eBay Step 2: no offerId returned");
  }

  // Step 3: Publish the offer
  console.log("[ebay] Step 3 — publishing offer:", offerId);
  const publishRes = await ebayFetch(
    accessToken,
    `/sell/inventory/v1/offer/${offerId}/publish`,
    "POST"
  );

  if (!publishRes.ok) {
    throw new Error(
      `eBay Step 3 failed (publish): HTTP ${publishRes.status}`
    );
  }

  const listingId = (publishRes.data as { listingId?: string })?.listingId;
  const ebayUrl = listingId
    ? `https://www.ebay.com/itm/${listingId}`
    : "https://www.ebay.com/mys/selling";

  console.log("[ebay] Listing published successfully:", ebayUrl);
  return ebayUrl;
}
