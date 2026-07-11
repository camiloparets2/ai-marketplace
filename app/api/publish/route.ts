// Multi-platform publish — the heart of "snap a photo, it's listed everywhere".
//
// Fan-out per selected target:
//   ebay / etsy      → live API publish using the stored OAuth connection
//   facebook/offerup → assisted post: no public listing API exists, so we
//                      return pre-composed copy + a deep link into their
//                      create-listing flow (the UI handles clipboard + photo)
//   direct           → Stripe Payment Link (the original Phase 1 flow)
//
// Targets are independent: one platform failing never blocks the others.
// The response is a per-target result list the UI renders as status cards.

export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { validateImageBytes, MAX_LISTING_PHOTOS } from "@/lib/image-validation";
import type { AcceptedMimeType } from "@/lib/image-validation";
import type {
  ListingInput,
  Platform,
  PublishResult,
} from "@/lib/platforms/types";
import { ASSIST_POST_URLS } from "@/lib/platforms/types";
import { assistCopyText, composeListing } from "@/lib/platforms/compose";
import { getConnection } from "@/lib/connections";
import { hostListingPhoto } from "@/lib/storage";
import { publishToEbay } from "@/lib/platforms/ebay";
import { publishToEtsy } from "@/lib/platforms/etsy";
import { publishToShopify } from "@/lib/platforms/shopify";
import { createPaymentLink } from "@/lib/stripe-link";
import { requireUser } from "@/lib/auth/guard";
import { checkRateLimit, requestIdentity, RATE_RULES } from "@/lib/rate-limit";
import { trackEvent } from "@/lib/telemetry";
import {
  createInventoryItem,
  recordLiveListing,
  recordPublishAttempt,
  markItemListed,
} from "@/lib/inventory";
import type { LiveListing } from "@/lib/inventory";

type PublishTarget = Platform | "direct";

interface PublishBody {
  listing: ListingInput;
  image: string; // base64 primary photo — same one sent to /api/analyze
  mimeType: AcceptedMimeType;
  targets: PublishTarget[];
  // Up to MAX_LISTING_PHOTOS - 1 additional base64 photos (same mimeType).
  // eBay lists them all; Etsy/Shopify currently use the primary only.
  extraImages?: string[];
}

// "direct" produces the same result shapes as platforms; widen the platform
// field on each union member (a plain Omit would collapse the union).
type TargetResult = {
  [K in PublishResult["status"]]: Omit<
    Extract<PublishResult, { status: K }>,
    "platform"
  > & { platform: PublishTarget };
}[PublishResult["status"]];

const VALID_TARGETS: ReadonlySet<string> = new Set([
  "ebay",
  "etsy",
  "shopify",
  "facebook",
  "offerup",
  "direct",
]);

function parseBody(raw: unknown): PublishBody | string {
  const body = raw as Partial<PublishBody> | null;
  if (!body || typeof body !== "object") return "Invalid request body";

  const { listing, image, mimeType, targets, extraImages } = body;
  if (extraImages !== undefined) {
    if (
      !Array.isArray(extraImages) ||
      extraImages.some((i) => typeof i !== "string" || !i)
    )
      return "extraImages must be an array of base64 strings";
    if (extraImages.length > MAX_LISTING_PHOTOS - 1)
      return `At most ${MAX_LISTING_PHOTOS} photos per listing`;
  }
  if (!listing || typeof listing !== "object") return "Missing listing";
  if (typeof listing.title !== "string" || !listing.title.trim())
    return "A listing title is required";
  if (
    typeof listing.price !== "number" ||
    listing.price <= 0 ||
    !isFinite(listing.price)
  )
    return "Price must be a positive number";
  if (typeof image !== "string" || !image) return "Missing image";
  if (
    mimeType !== "image/jpeg" &&
    mimeType !== "image/png" &&
    mimeType !== "image/webp"
  )
    return "mimeType must be image/jpeg, image/png, or image/webp";
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.some((t) => !VALID_TARGETS.has(t))
  )
    return "targets must be a non-empty array of: ebay, etsy, shopify, facebook, offerup, direct";

  return { listing, image, mimeType, targets, extraImages };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Every publish is user-scoped so inventory and external listings can be
  // reconciled and delisted safely.
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const allowed = await checkRateLimit(
    RATE_RULES.publish,
    requestIdentity(req, userId)
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many publishes too fast — please wait a bit and try again." },
      { status: 429 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if (typeof parsed === "string") {
    return NextResponse.json({ error: parsed }, { status: 400 });
  }
  const { listing, image, mimeType, targets, extraImages } = parsed;

  const imageBytes = new Uint8Array(Buffer.from(image, "base64"));
  const validation = validateImageBytes(imageBytes);
  if (!validation.valid) {
    return NextResponse.json(
      { error: validation.error ?? "Invalid image" },
      { status: 400 }
    );
  }
  const extraBytes: Uint8Array[] = [];
  for (const extra of extraImages ?? []) {
    const bytes = new Uint8Array(Buffer.from(extra, "base64"));
    const check = validateImageBytes(bytes);
    if (!check.valid) {
      return NextResponse.json(
        { error: `One of the extra photos is invalid: ${check.error ?? ""}` },
        { status: 400 }
      );
    }
    extraBytes.push(bytes);
  }

  // eBay needs the photos at public URLs. Host once, lazily, shared across
  // targets; the primary photo is first (the marketplace hero image).
  let hostedUrlsPromise: Promise<string[]> | null = null;
  function hostedUrls(): Promise<string[]> {
    hostedUrlsPromise ??= Promise.all([
      hostListingPhoto(imageBytes, mimeType),
      ...extraBytes.map((bytes) => hostListingPhoto(bytes, mimeType)),
    ]);
    return hostedUrlsPromise;
  }
  const hostedUrl = async (): Promise<string> => (await hostedUrls())[0];

  // Live publishes carry platform-side ids the inventory layer needs to end
  // the listing later (anti-oversell). Collected during fan-out, written after.
  const liveRecords: LiveListing[] = [];

  async function publishTo(target: PublishTarget): Promise<TargetResult> {
    try {
      switch (target) {
        case "ebay":
        case "etsy":
        case "shopify": {
          // Marketplace publishing uses the signed-in user's stored tokens.
          const conn = await getConnection(userId, target);
          if (!conn) {
            return {
              platform: target,
              status: "not_connected",
              // Shopify connect needs a shop domain first — route via the hub.
              connectUrl:
                target === "shopify" ? "/channels" : `/api/oauth/${target}/start`,
            };
          }
          if (target === "ebay") {
            const published = await publishToEbay(conn, listing, await hostedUrls());
            liveRecords.push({
              platform: "ebay",
              url: published.url,
              externalId: published.listingId,
              meta: { offerId: published.offerId, sku: published.sku },
            });
            return { platform: target, status: "live", url: published.url };
          }
          if (target === "shopify") {
            const published = await publishToShopify(conn, listing, image);
            liveRecords.push({
              platform: "shopify",
              url: published.url,
              externalId: published.productId,
              meta: { shop: published.shop },
            });
            return { platform: target, status: "live", url: published.url };
          }
          const published = await publishToEtsy(conn, listing, imageBytes, mimeType);
          liveRecords.push({
            platform: "etsy",
            url: published.url,
            externalId: published.listingId,
            meta: { shopId: published.shopId },
          });
          return { platform: target, status: "live", url: published.url };
        }
        case "facebook":
        case "offerup": {
          const composed = composeListing(target, listing);
          return {
            platform: target,
            status: "assist",
            postUrl: ASSIST_POST_URLS[target],
            copyText: assistCopyText(target, listing),
            title: composed.title,
            description: composed.description,
            price: listing.price,
          };
        }
        case "direct": {
          const composed = composeListing("ebay", listing);
          const link = await createPaymentLink(
            listing.title,
            listing.price,
            composed.description
          );
          liveRecords.push({
            platform: "direct",
            url: link.url,
            externalId: link.id,
            meta: {},
          });
          return { platform: target, status: "live", url: link.url };
        }
      }
    } catch (err) {
      console.error(`[publish:${target}]`, err);
      return {
        platform: target,
        status: "error",
        message:
          err instanceof Error ? err.message : "Publishing failed. Try again.",
      };
    }
  }

  // Establish the inventory source-of-truth before any external listing can
  // go live. If this fails, stop before creating an untracked marketplace item.
  let inventoryItemId: string;
  try {
    const photoUrl = targets.includes("ebay")
      ? await hostedUrl().catch(() => null)
      : null;
    inventoryItemId = await createInventoryItem(userId, listing, photoUrl);
  } catch (err) {
    console.error("[publish] inventory creation failed:", err);
    return NextResponse.json(
      {
        error:
          "Your inventory could not be saved, so nothing was published. Please try again.",
        retryable: true,
      },
      { status: 503 }
    );
  }

  const results = await Promise.all(targets.map(publishTo));

  // Attach platform-side ids to the inventory item for sold/delist sync.
  let inventorySyncError = false;
  try {
    for (const record of liveRecords) {
      await recordLiveListing(userId, inventoryItemId, record, listing.price);
    }
    if (liveRecords.length > 0) await markItemListed(inventoryItemId);

    for (const result of results) {
      await recordPublishAttempt(
        userId,
        inventoryItemId,
        result.platform,
        result.status,
        result.status === "error" ? result.message : undefined
      );
    }
  } catch (err) {
    inventorySyncError = true;
    console.error("[publish] live-listing reconciliation failed:", err);
  }

  // Funnel: one event per publish run, plus one per failed target so
  // channel-level breakage is queryable.
  const liveCount = results.filter((r) => r.status === "live").length;
  await trackEvent(userId, "published", {
    targets,
    liveCount,
    inventoryItemId,
  });
  for (const result of results) {
    if (result.status === "error") {
      await trackEvent(userId, "publish_error", {
        platform: result.platform,
        message: result.message,
      });
    }
  }

  return NextResponse.json({ results, inventoryItemId, inventorySyncError });
}
