// "Set up automatically" — the explicit remediation action behind the eBay
// checklist on /channels (docs/design/ebay-seller-readiness.md).
//
// Runs the full ensure chains (ship-from location, then business policies:
// opt-in + default-policy creation as needed). POST because it can mutate
// the seller's eBay account — the channels GET stays detect-only.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import {
  ensureEbayLocation,
  ensureEbayPolicies,
  EbayShipFromMissingError,
  EbaySellerSetupError,
  EBAY_SELLER_REGISTRATION_URL,
} from "@/lib/platforms/ebay";

export interface EbayReadinessFixResult {
  shipFrom: boolean;
  policies: "ready" | "not_registered" | "pending";
  message?: string;
  actionUrl?: string;
}

export async function POST(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conn = await getConnection(user.id, "ebay").catch(() => null);
  if (!conn) {
    return NextResponse.json(
      { error: "Connect eBay first." },
      { status: 409 }
    );
  }

  try {
    const { marketplace } = await ensureEbayLocation(conn);
    await ensureEbayPolicies(conn, marketplace);
    const result: EbayReadinessFixResult = { shipFrom: true, policies: "ready" };
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof EbayShipFromMissingError) {
      const result: EbayReadinessFixResult = {
        shipFrom: false,
        policies: "pending",
        message: err.message,
        actionUrl: "/settings/ship-from",
      };
      return NextResponse.json(result);
    }
    if (err instanceof EbaySellerSetupError) {
      const result: EbayReadinessFixResult = {
        shipFrom: true,
        policies: err.kind === "not_registered" ? "not_registered" : "pending",
        message: err.message,
        ...(err.kind === "not_registered"
          ? { actionUrl: EBAY_SELLER_REGISTRATION_URL }
          : {}),
      };
      return NextResponse.json(result);
    }
    console.error("[ebay-readiness] setup failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "eBay setup failed — try again." },
      { status: 502 }
    );
  }
}
