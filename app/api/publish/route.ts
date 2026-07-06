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
import { validateImageBytes } from "@/lib/image-validation";
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
import { authenticateRequest } from "@/lib/auth/guard";
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
  image: string; // base64, same pre-processed photo sent to /api/analyze
  mimeType: AcceptedMimeType;
  targets: PublishTarget[];
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

  const { listing, image, mimeType, targets } = body;
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

  return { listing, image, mimeType, targets };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Session preferred; legacy beta key still allows the stateless targets
  // (assist platforms + direct Stripe link). eBay/Etsy require a user because
  // their connections are per-account.
  const { authorized, user } = await authenticateRequest(req);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await checkRateLimit(
    RATE_RULES.publish,
    requestIdentity(req, user?.id ?? null)
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
  const { listing, image, mimeType, targets } = parsed;

  const imageBytes = new Uint8Array(Buffer.from(image, "base64"));
  const validation = validateImageBytes(imageBytes);
  if (!validation.valid) {
    return NextResponse.json(
      { error: validation.error ?? "Invalid image" },
      { status: 400 }
    );
  }

  // eBay needs the photo at a public URL. Host it once, lazily, and share the
  // upload across targets.
  let hostedUrlPromise: Promise<string> | null = null;
  function hostedUrl(): Promise<string> {
    hostedUrlPromise ??= hostListingPhoto(imageBytes, mimeType);
    return hostedUrlPromise;
  }

  // Live publishes carry platform-side ids the inventory layer needs to end
  // the listing later (anti-oversell). Collected during fan-out, written after.
  const liveRecords: LiveListing[] = [];

  async function publishTo(target: PublishTarget): Promise<TargetResult> {
    try {
      switch (target) {
        case "ebay":
        case "etsy":
        case "shopify": {
          // Marketplace publishing is user-scoped; a beta key alone can't
          // reach anyone's tokens.
          if (!user) {
            return {
              platform: target,
              status: "not_connected",
              connectUrl: "/login",
            };
          }
          const conn = await getConnection(user.id, target);
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
            const published = await publishToEbay(conn, listing, await hostedUrl());
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

  const results = await Promise.all(targets.map(publishTo));

  // ── Inventory: source of truth ───────────────────────────────────────────
  // Record the item + its live listings so sold/delist sync can end them
  // everywhere later. Best-effort: an inventory write failure must never
  // undo a publish that already succeeded on the marketplaces.
  let inventoryItemId: string | null = null;
  if (user) {
    try {
      const photoUrl = await hostedUrl().catch(() => null);
      inventoryItemId = await createInventoryItem(user.id, listing, photoUrl);

      for (const record of liveRecords) {
        await recordLiveListing(user.id, inventoryItemId, record, listing.price);
      }
      if (liveRecords.length > 0) await markItemListed(inventoryItemId);

      for (const result of results) {
        await recordPublishAttempt(
          user.id,
          inventoryItemId,
          result.platform,
          result.status,
          result.status === "error" ? result.message : undefined
        );
      }
    } catch (err) {
      console.error("[publish] inventory recording failed:", err);
    }
  }

  // Funnel: one event per publish run, plus one per failed target so
  // channel-level breakage is queryable.
  const liveCount = results.filter((r) => r.status === "live").length;
  await trackEvent(user?.id ?? null, "published", {
    targets,
    liveCount,
    inventoryItemId,
  });
  for (const result of results) {
    if (result.status === "error") {
      await trackEvent(user?.id ?? null, "publish_error", {
        platform: result.platform,
        message: result.message,
      });
    }
  }

  return NextResponse.json({ results, inventoryItemId });
}
