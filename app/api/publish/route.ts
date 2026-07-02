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
import { createPaymentLink } from "@/lib/stripe-link";

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
    return "targets must be a non-empty array of: ebay, etsy, facebook, offerup, direct";

  return { listing, image, mimeType, targets };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Same pre-shared beta key gate as /api/analyze.
  const incomingKey = req.headers.get("x-api-key");
  if (
    !process.env.APP_INTERNAL_BETA_KEY ||
    incomingKey !== process.env.APP_INTERNAL_BETA_KEY
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  async function publishTo(target: PublishTarget): Promise<TargetResult> {
    try {
      switch (target) {
        case "ebay": {
          const conn = await getConnection("ebay");
          if (!conn) {
            return {
              platform: target,
              status: "not_connected",
              connectUrl: "/api/oauth/ebay/start",
            };
          }
          const url = await publishToEbay(conn, listing, await hostedUrl());
          return { platform: target, status: "live", url };
        }
        case "etsy": {
          const conn = await getConnection("etsy");
          if (!conn) {
            return {
              platform: target,
              status: "not_connected",
              connectUrl: "/api/oauth/etsy/start",
            };
          }
          const url = await publishToEtsy(conn, listing, imageBytes, mimeType);
          return { platform: target, status: "live", url };
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
          const url = await createPaymentLink(
            listing.title,
            listing.price,
            composed.description
          );
          return { platform: target, status: "live", url };
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
  return NextResponse.json({ results });
}
