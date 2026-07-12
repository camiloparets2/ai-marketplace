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
import {
  publishToEbay,
  ebaySkuForItem,
  EbayShipFromMissingError,
  EbaySellerSetupError,
} from "@/lib/platforms/ebay";
import { publishToEtsy } from "@/lib/platforms/etsy";
import { publishToShopify } from "@/lib/platforms/shopify";
import { createPaymentLink } from "@/lib/stripe-link";
import { requireUser } from "@/lib/auth/guard";
import {
  checkRateLimit,
  requestIdentity,
  RATE_RULES,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
} from "@/lib/rate-limit";
import { trackEvent } from "@/lib/telemetry";
import {
  createInventoryItem,
  recordLiveListing,
  recordPublishAttempt,
  beginPublishAttempt,
  completePublishAttempt,
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
// field on each union member (a plain Omit would collapse the union), and
// every result may carry its persist-before-publish attempt row id plus the
// reconciliation flag (live on the platform, local recording failed).
type TargetResult = {
  [K in PublishResult["status"]]: Omit<
    Extract<PublishResult, { status: K }>,
    "platform"
  > & {
    platform: PublishTarget;
    attemptId?: string;
    reconciliationRequired?: boolean;
  };
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
  // A signed-in user, always: every publish must be attributable to the
  // account whose marketplace tokens and inventory it touches. (The legacy
  // beta-key path that allowed anonymous assist/direct publishes is gone.)
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const rate = await checkRateLimit(
    RATE_RULES.publish,
    requestIdentity(req, user.id)
  );
  if (rate === "limited") {
    return NextResponse.json(
      { error: "Too many publishes too fast — please wait a bit and try again." },
      { status: 429 }
    );
  }
  if (rate === "unavailable") {
    return NextResponse.json(
      { error: RATE_LIMIT_UNAVAILABLE_MESSAGE },
      { status: 503 }
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

  // ── Persist BEFORE publish ─────────────────────────────────────────────────
  // The inventory item exists before any marketplace is called, so a publish
  // can never produce a listing the app doesn't know about. If we can't
  // persist, we don't publish.
  const photoUrl = await hostedUrl().catch(() => null);
  let inventoryItemId: string;
  try {
    inventoryItemId = await createInventoryItem(userId, listing, photoUrl);
  } catch (err) {
    console.error("[publish] could not persist the item — refusing to publish:", err);
    return NextResponse.json(
      {
        error:
          "We couldn't save your item just now, so nothing was published. Please try again in a moment.",
      },
      { status: 503 }
    );
  }

  // True when any live listing failed to record locally — the attempt row
  // carries the platform ids for recovery.
  let reconciliationRequired = false;
  let anyLive = false;

  // Publish one marketplace target with the persist-before-publish contract:
  // pending attempt row → external call → record listing + complete row.
  // A local recording failure AFTER the platform call marks the attempt
  // reconciliation_required (with the platform ids) — never an untracked
  // live listing.
  async function publishExternal(
    target: "ebay" | "etsy" | "shopify" | "direct",
    call: () => Promise<LiveListing>
  ): Promise<TargetResult> {
    let attemptId: string;
    try {
      attemptId = await beginPublishAttempt(userId, inventoryItemId, target);
    } catch (err) {
      console.error(`[publish:${target}] attempt row failed — not publishing:`, err);
      return {
        platform: target,
        status: "error",
        message:
          "We couldn't record this publish attempt, so nothing was sent — try again.",
      };
    }
    let record: LiveListing;
    try {
      record = await call();
    } catch (err) {
      const mapped = mapPublishError(target, err);
      await completePublishAttempt(attemptId, {
        status: "error",
        error: mapped.message,
      });
      return { ...mapped, attemptId };
    }
    anyLive = true;
    const platformIds = {
      externalId: record.externalId,
      url: record.url,
      meta: record.meta,
    };
    try {
      await recordLiveListing(userId, inventoryItemId, record, listing.price);
      await completePublishAttempt(attemptId, { status: "live", ...platformIds });
      return { platform: target, status: "live", url: record.url, attemptId };
    } catch (err) {
      console.error(
        `[publish:${target}] RECONCILIATION: live listing ${record.externalId} failed to record:`,
        err
      );
      reconciliationRequired = true;
      await completePublishAttempt(attemptId, {
        status: "reconciliation_required",
        error: err instanceof Error ? err.message : "recording failed",
        ...platformIds,
      });
      return {
        platform: target,
        status: "live",
        url: record.url,
        attemptId,
        reconciliationRequired: true,
      };
    }
  }

  async function publishTo(target: PublishTarget): Promise<TargetResult> {
    try {
      switch (target) {
        case "ebay":
        case "etsy":
        case "shopify": {
          const conn = await getConnection(userId, target);
          if (!conn) {
            await recordPublishAttempt(userId, inventoryItemId, target, "not_connected");
            return {
              platform: target,
              status: "not_connected",
              // Shopify connect needs a shop domain first — route via the hub.
              connectUrl:
                target === "shopify" ? "/channels" : `/api/oauth/${target}/start`,
            };
          }
          if (target === "ebay") {
            return publishExternal("ebay", async () => {
              const published = await publishToEbay(
                conn,
                listing,
                await hostedUrls(),
                ebaySkuForItem(inventoryItemId)
              );
              return {
                platform: "ebay",
                url: published.url,
                externalId: published.listingId,
                meta: { offerId: published.offerId, sku: published.sku },
              };
            });
          }
          if (target === "shopify") {
            return publishExternal("shopify", async () => {
              const published = await publishToShopify(conn, listing, image);
              return {
                platform: "shopify",
                url: published.url,
                externalId: published.productId,
                meta: { shop: published.shop },
              };
            });
          }
          return publishExternal("etsy", async () => {
            const published = await publishToEtsy(conn, listing, imageBytes, mimeType);
            return {
              platform: "etsy",
              url: published.url,
              externalId: published.listingId,
              meta: { shopId: published.shopId },
            };
          });
        }
        case "facebook":
        case "offerup": {
          // Pure copy composition — no external call, so a one-shot row.
          const composed = composeListing(target, listing);
          await recordPublishAttempt(userId, inventoryItemId, target, "assist");
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
          return publishExternal("direct", async () => {
            const composed = composeListing("ebay", listing);
            const link = await createPaymentLink(
              listing.title,
              listing.price,
              composed.description
            );
            return { platform: "direct", url: link.url, externalId: link.id, meta: {} };
          });
        }
      }
    } catch (err) {
      // Failures before any external call (e.g. connection lookup).
      const mapped = mapPublishError(target, err);
      await recordPublishAttempt(
        userId,
        inventoryItemId,
        target,
        "error",
        mapped.message
      );
      return mapped;
    }
  }

  const results = await Promise.all(targets.map(publishTo));
  if (anyLive) {
    await markItemListed(inventoryItemId).catch((err: unknown) => {
      // Listings + attempts are already recorded; only the item's lifecycle
      // stamp failed. Flag it rather than lose the signal.
      console.error("[publish] RECONCILIATION: markItemListed failed:", err);
      reconciliationRequired = true;
    });
  }

  // Funnel: one event per publish run, plus one per failed target so
  // channel-level breakage is queryable.
  const liveCount = results.filter((r) => r.status === "live").length;
  await trackEvent(user.id, "published", {
    targets,
    liveCount,
    inventoryItemId,
    reconciliationRequired,
  });
  for (const result of results) {
    if (result.status === "error") {
      await trackEvent(user.id, "publish_error", {
        platform: result.platform,
        message: result.message,
      });
    }
  }

  return NextResponse.json({ results, inventoryItemId, reconciliationRequired });
}

// Map a marketplace failure to the actionable per-target error result.
// Missing ship-from is fixable in-app; seller onboarding gets the
// registration CTA on the seller's own marketplace; never a raw eBay 400.
function mapPublishError(
  target: PublishTarget,
  err: unknown
): Extract<TargetResult, { status: "error" }> {
  console.error(`[publish:${target}]`, err);
  if (err instanceof EbayShipFromMissingError) {
    return {
      platform: target,
      status: "error",
      message: err.message,
      actionUrl: "/settings/ship-from",
      actionLabel: "Add ship-from location →",
    };
  }
  if (err instanceof EbaySellerSetupError) {
    return {
      platform: target,
      status: "error",
      message: err.message,
      ...(err.kind === "not_registered"
        ? {
            actionUrl: err.registrationUrl,
            actionLabel: "Finish your eBay seller setup →",
          }
        : err.kind === "policies_unconfirmed"
          ? {
              actionUrl: "/channels",
              actionLabel: "Review & confirm your policies →",
            }
          : {}),
    };
  }
  return {
    platform: target,
    status: "error",
    message: err instanceof Error ? err.message : "Publishing failed. Try again.",
  };
}
