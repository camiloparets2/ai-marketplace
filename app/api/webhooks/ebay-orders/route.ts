// eBay order-event intake (docs/design/launch.md P0-6).
//
// Push half of the sold-signal story: eBay's Notification API delivers
// order events here; each sold line item is normalized into the sold_events
// queue (deduplicated) and the queue is drained immediately. The daily
// polling sync stays on as the backstop for anything push misses.
//
//   GET  — eBay's endpoint-verification challenge: same
//          sha256(challengeCode + verificationToken + endpoint) hex scheme
//          as the account-deletion endpoint, with its own token pair.
//   POST — the notification. Tolerant parse → enqueue → drain → fast 200.
//
// Env (never hardcode):
//   EBAY_ORDER_WEBHOOK_VERIFICATION_TOKEN   32–80 chars, [A-Za-z0-9_-]
//   EBAY_ORDER_WEBHOOK_ENDPOINT             this route's exact public URL

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  recordSoldEvent,
  findListingOwner,
  processPendingSoldEvents,
} from "@/lib/sold-events";

export const maxDuration = 60;

// ─── GET: challenge validation ────────────────────────────────────────────────

export function GET(req: NextRequest): NextResponse {
  const challengeCode = req.nextUrl.searchParams.get("challenge_code");
  if (!challengeCode) {
    return NextResponse.json(
      { error: "Missing challenge_code query parameter" },
      { status: 400 }
    );
  }

  const verificationToken = process.env.EBAY_ORDER_WEBHOOK_VERIFICATION_TOKEN;
  const endpoint = process.env.EBAY_ORDER_WEBHOOK_ENDPOINT;
  if (!verificationToken || !endpoint) {
    console.error(
      "[ebay-orders] Not configured:",
      !verificationToken ? "missing verification token" : "",
      !endpoint ? "missing endpoint URL" : ""
    );
    return NextResponse.json(
      { error: "Endpoint is not configured" },
      { status: 500 }
    );
  }

  const challengeResponse = createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");
  return NextResponse.json({ challengeResponse });
}

// ─── POST: order notification ─────────────────────────────────────────────────

// Tolerant view of an eBay order notification. eBay's schemas differ across
// notification topics/versions, so every access is optional and the raw body
// is preserved on the queue row for forensics.
interface NotificationLineItem {
  legacyItemId?: string;
  listingId?: string;
  itemId?: string;
  sku?: string;
  total?: { value?: string };
  lineItemCost?: { value?: string };
}

interface OrderNotification {
  notification?: {
    notificationId?: string;
    data?: {
      orderId?: string;
      legacyOrderId?: string;
      lineItems?: NotificationLineItem[];
    };
  };
}

function money(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: OrderNotification;
  try {
    body = (await req.json()) as OrderNotification;
  } catch {
    // Malformed body — 400 so eBay retries rather than assuming success.
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data = body.notification?.data;
  const orderId = data?.orderId ?? data?.legacyOrderId;
  const notificationId = body.notification?.notificationId ?? "unknown";

  if (!orderId || !data?.lineItems?.length) {
    // Not an order-shaped payload — ACK so eBay doesn't hammer retries; the
    // polling backstop covers anything we couldn't parse.
    console.warn(`[ebay-orders] Unparseable notification ${notificationId}`);
    return new NextResponse(null, { status: 200 });
  }

  const affectedUsers = new Set<string>();
  for (const line of data.lineItems) {
    const listingId = line.legacyItemId ?? line.listingId ?? line.itemId ?? null;
    const sku = line.sku ?? null;

    // Attribute the sale to a seller by the listing we published.
    const owner = await findListingOwner("ebay", listingId, sku);
    if (!owner) {
      console.warn(
        `[ebay-orders] No listing match for order ${orderId} line (listing=${listingId ?? "?"}, sku=${sku ?? "?"})`
      );
      continue;
    }

    try {
      await recordSoldEvent({
        userId: owner.userId,
        platform: "ebay",
        externalOrderId: orderId,
        listingExternalId: listingId,
        sku,
        salePrice: money(line.total?.value ?? line.lineItemCost?.value),
        source: "webhook",
        raw: { notificationId },
      });
      affectedUsers.add(owner.userId);
    } catch (err) {
      // Enqueue failure must not lose the notification — non-2xx → eBay retries.
      console.error("[ebay-orders] enqueue failed:", err);
      return new NextResponse(null, { status: 500 });
    }
  }

  // Drain now — the ACK deadline is generous enough for a few claims, and
  // anything left over is picked up by the next sync pass.
  for (const userId of affectedUsers) {
    try {
      await processPendingSoldEvents(userId);
    } catch (err) {
      console.error(`[ebay-orders] processing failed for ${userId}:`, err);
      // Events stay 'pending'; the polling backstop will drain them.
    }
  }

  return new NextResponse(null, { status: 200 });
}
