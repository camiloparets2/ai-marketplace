import { createHash } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EbayMarketplaceAccountDeletionNotification = {
  metadata?: {
    topic?: string;
    schemaVersion?: string;
    deprecated?: boolean;
  };
  notification?: {
    notificationId?: string;
    eventDate?: string;
    publishDate?: string;
    publishAttemptCount?: number;
    data?: {
      username?: string;
      userId?: string;
      eiasToken?: string;
    };
  };
};

const VERIFICATION_TOKEN_ENV =
  "EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN";
const ENDPOINT_ENV = "EBAY_MARKETPLACE_DELETION_ENDPOINT";

function sha256Hex(...parts: string[]): string {
  const hash = createHash("sha256");

  for (const part of parts) {
    hash.update(part, "utf8");
  }

  return hash.digest("hex");
}

function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identifierHash(value: unknown): string | undefined {
  const text = presentString(value);
  return text ? sha256Hex(text).slice(0, 16) : undefined;
}

function toNotification(
  value: unknown
): EbayMarketplaceAccountDeletionNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as EbayMarketplaceAccountDeletionNotification;
}

function safeLogSummary(
  payload: EbayMarketplaceAccountDeletionNotification
) {
  const notification = payload.notification;
  const data = notification?.data;

  return {
    topic: payload.metadata?.topic,
    schemaVersion: payload.metadata?.schemaVersion,
    deprecated: payload.metadata?.deprecated,
    notificationId: notification?.notificationId,
    eventDate: notification?.eventDate,
    publishDate: notification?.publishDate,
    publishAttemptCount: notification?.publishAttemptCount,
    ebayUserIdHash: identifierHash(data?.userId),
    ebayUsernameHash: identifierHash(data?.username),
    eiasTokenHash: identifierHash(data?.eiasToken),
  };
}

async function deleteOrAnonymizeStoredEbayUserData(
  payload: EbayMarketplaceAccountDeletionNotification
): Promise<void> {
  const data = payload.notification?.data;

  // TODO: Delete or irreversibly anonymize every stored record tied to this
  // eBay user. Match against stored eBay account identifiers once persisted,
  // then remove eBay OAuth tokens and marketplace data from seller_profiles,
  // listings, logs, analytics, storage objects, and any backups covered by the
  // app's retention policy.
  console.log("[ebay/account-deletion] deletion hook pending", {
    notificationId: payload.notification?.notificationId,
    ebayUserIdHash: identifierHash(data?.userId),
    ebayUsernameHash: identifierHash(data?.username),
    eiasTokenHash: identifierHash(data?.eiasToken),
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const challengeCode = req.nextUrl.searchParams.get("challenge_code");

  if (!challengeCode) {
    return NextResponse.json(
      { error: "challenge_code is required" },
      { status: 400 }
    );
  }

  const verificationToken = process.env[VERIFICATION_TOKEN_ENV];
  const endpoint = process.env[ENDPOINT_ENV];

  if (!verificationToken || !endpoint) {
    console.error("[ebay/account-deletion] Missing required env vars", {
      hasVerificationToken: Boolean(verificationToken),
      hasEndpoint: Boolean(endpoint),
    });

    return NextResponse.json(
      { error: "Marketplace account deletion endpoint is not configured" },
      { status: 500 }
    );
  }

  const challengeResponse = sha256Hex(
    challengeCode,
    verificationToken,
    endpoint
  );

  return NextResponse.json({ challengeResponse }, { status: 200 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = toNotification(body);

  console.log(
    "[ebay/account-deletion] received notification",
    safeLogSummary(payload)
  );

  after(async () => {
    try {
      await deleteOrAnonymizeStoredEbayUserData(payload);
    } catch (error) {
      console.error(
        "[ebay/account-deletion] deletion hook failed",
        error instanceof Error ? error.message : error
      );
    }
  });

  return NextResponse.json({ received: true }, { status: 202 });
}
