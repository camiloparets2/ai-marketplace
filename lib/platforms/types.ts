// ─── Platform identifiers ─────────────────────────────────────────────────────
//
// Two integration classes, kept explicit so the UI can render honest CTAs:
//   api    — platform exposes a public listing API; we post directly (eBay, Etsy)
//   assist — no public listing API exists (Facebook Marketplace, OfferUp); we
//            generate a ready-to-paste listing + deep link into their post flow.

export type ApiPlatform = "ebay" | "etsy" | "shopify";
export type AssistPlatform = "facebook" | "offerup";
export type Platform = ApiPlatform | AssistPlatform;

export const API_PLATFORMS: ReadonlyArray<ApiPlatform> = [
  "ebay",
  "etsy",
  "shopify",
];
export const ASSIST_PLATFORMS: ReadonlyArray<AssistPlatform> = [
  "facebook",
  "offerup",
];
export const ALL_PLATFORMS: ReadonlyArray<Platform> = [
  ...API_PLATFORMS,
  ...ASSIST_PLATFORMS,
];

export const PLATFORM_DISPLAY_NAMES: Record<Platform, string> = {
  ebay: "eBay",
  etsy: "Etsy",
  shopify: "Shopify",
  facebook: "Facebook Marketplace",
  offerup: "OfferUp",
};

// Deep links into each assist platform's "create listing" flow.
export const ASSIST_POST_URLS: Record<AssistPlatform, string> = {
  facebook: "https://www.facebook.com/marketplace/create/item",
  offerup: "https://offerup.com/post/",
};

// ─── Listing input ────────────────────────────────────────────────────────────

// The reviewed, user-confirmed listing data sent to /api/publish.
// This is the extraction result after the user has edited it — the publish
// pipeline never trusts raw extraction output directly.
export interface ListingInput {
  title: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  condition: "New" | "Like New" | "Very Good" | "Good" | "Acceptable";
  category: string;
  specs: Record<string, string>;
  price: number; // USD dollars
  shippingCost: number | null; // null → seller handles shipping manually
}

// ─── Composed per-platform listing ────────────────────────────────────────────

export interface ComposedListing {
  platform: Platform;
  title: string; // truncated to the platform's title limit
  description: string;
  tags: string[]; // Etsy only; empty elsewhere
}

// ─── Publish results ──────────────────────────────────────────────────────────

export type PublishResult =
  | {
      platform: Platform;
      status: "live";
      // Public URL of the live listing.
      url: string;
    }
  | {
      platform: Platform;
      status: "assist";
      // Deep link to the platform's create-listing page.
      postUrl: string;
      // Pre-composed text the user pastes into the listing form.
      copyText: string;
      title: string;
      description: string;
      price: number;
    }
  | {
      platform: Platform;
      status: "not_connected";
      // Where to start the OAuth flow.
      connectUrl: string;
    }
  | {
      platform: Platform;
      status: "error";
      message: string;
    };

// ─── Stored OAuth connection ──────────────────────────────────────────────────

export interface PlatformConnection {
  // Owning Supabase auth user. Connections are per-user; the OAuth callback
  // stamps this from the signed-in session before saving.
  userId: string;
  platform: ApiPlatform;
  accessToken: string;
  refreshToken: string | null;
  // Epoch milliseconds when the access token expires; null → unknown.
  expiresAt: number | null;
  // Platform-specific extras (e.g. Etsy shop_id) cached at connect time.
  meta: Record<string, string>;
}

// A token bundle fresh from an OAuth code exchange, before it's attributed
// to the signed-in user.
export type UnownedConnection = Omit<PlatformConnection, "userId">;
