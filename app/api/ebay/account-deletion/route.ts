// eBay Marketplace Account Deletion / Closure notification endpoint.
//
// Required for a Production keyset: eBay calls this endpoint when one of their
// users deletes their account, and we must erase any of that user's data we
// hold. It has two jobs:
//
//   GET  — one-time (and periodic) challenge validation. eBay sends
//          ?challenge_code=… and expects back the SHA-256 hash of
//          challengeCode + verificationToken + endpoint, as JSON.
//   POST — the actual deletion notification. We ACK fast (must respond well
//          under eBay's timeout) and hand off the erasure to a hook.
//
// Docs: https://developer.ebay.com/marketplace-account-deletion
//
// Env (never hardcode — see .env.example):
//   EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN  32–80 chars, [A-Za-z0-9_-]
//   EBAY_MARKETPLACE_DELETION_ENDPOINT            the exact public HTTPS URL
//                                                 eBay is configured to call
//
// This route reads NO client secret / cert id — those are unrelated to this
// flow and must never be logged here.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { handleEbayAccountDeletion } from "@/lib/platforms/ebay-deletion";

// ─── GET: challenge validation ────────────────────────────────────────────────

export function GET(req: NextRequest): NextResponse {
  const challengeCode = req.nextUrl.searchParams.get("challenge_code");

  if (!challengeCode) {
    return NextResponse.json(
      { error: "Missing challenge_code query parameter" },
      { status: 400 }
    );
  }

  const verificationToken =
    process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN;
  const endpoint = process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT;

  if (!verificationToken || !endpoint) {
    // Never echo the values — just report which knobs are unset.
    console.error(
      "[ebay-deletion] Not configured:",
      !verificationToken ? "missing verification token" : "",
      !endpoint ? "missing endpoint URL" : ""
    );
    return NextResponse.json(
      { error: "Endpoint is not configured" },
      { status: 500 }
    );
  }

  // Hash order is mandated by eBay and must be exactly:
  //   challengeCode + verificationToken + endpoint
  // digested as hex.
  const challengeResponse = createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");

  // eBay requires 200 + application/json. NextResponse.json sets the header.
  return NextResponse.json({ challengeResponse });
}

// ─── POST: deletion notification ──────────────────────────────────────────────

interface EbayDeletionNotification {
  metadata?: { topic?: string; schemaVersion?: string };
  notification?: {
    notificationId?: string;
    eventDate?: string;
    publishDate?: string;
    data?: {
      username?: string;
      userId?: string;
      eiasToken?: string;
    };
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: EbayDeletionNotification;
  try {
    body = (await req.json()) as EbayDeletionNotification;
  } catch {
    // Malformed body — 400 so eBay retries rather than assuming success.
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data = body.notification?.data;
  const notificationId = body.notification?.notificationId ?? "unknown";

  // Safe logging: identifiers only, never tokens/secrets. userId is what eBay
  // wants us to act on; that's an eBay-side account id, not a credential.
  console.log(
    `[ebay-deletion] Received notification ${notificationId} for eBay userId=${
      data?.userId ?? "unknown"
    }`
  );

  // Hand off the actual erasure. We deliberately do NOT await long-running work
  // in a way that would risk eBay's ACK timeout — the hook is written to be
  // fast (or to enqueue). Any failure is logged but we still ACK, because eBay
  // will re-send on non-2xx and duplicate deletions are idempotent for us.
  try {
    if (data?.userId || data?.username) {
      await handleEbayAccountDeletion({
        userId: data?.userId ?? null,
        username: data?.username ?? null,
        notificationId,
      });
    }
  } catch (err) {
    console.error(
      `[ebay-deletion] Erasure hook failed for notification ${notificationId}:`,
      err instanceof Error ? err.message : err
    );
    // Fall through to 200 anyway — see note above. If you'd rather have eBay
    // retry, return status 500 here instead.
  }

  // 200 (or 202) tells eBay the notification was accepted.
  return new NextResponse(null, { status: 200 });
}
