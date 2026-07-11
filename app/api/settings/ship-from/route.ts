// Ship-from location settings (docs/design/ship-from-location.md).
//
// GET → the signed-in seller's stored ship-from address + whether their eBay
//       connection already has a merchant location resolved.
// PUT → validate (lib/ship-from.ts — same rules as the form), persist, and
//       when eBay is connected without a location yet, create it immediately
//       so the seller leaves this page ready to publish.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection } from "@/lib/connections";
import { getShipFromLocation, saveShipFromLocation } from "@/lib/locations";
import { validateShipFrom } from "@/lib/ship-from";
import { ensureEbayLocation } from "@/lib/platforms/ebay";

export interface ShipFromStatus {
  shipFrom: {
    country: string;
    postalCode: string | null;
    city: string | null;
    stateOrProvince: string | null;
  } | null;
  ebay: { connected: boolean; locationReady: boolean };
}

async function ebayStatus(
  userId: string
): Promise<ShipFromStatus["ebay"]> {
  try {
    const conn = await getConnection(userId, "ebay");
    return {
      connected: conn !== null,
      locationReady: Boolean(conn?.meta.merchantLocationKey),
    };
  } catch {
    return { connected: false, locationReady: false };
  }
}

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [shipFrom, ebay] = await Promise.all([
    getShipFromLocation(user.id).catch(() => null),
    ebayStatus(user.id),
  ]);
  const status: ShipFromStatus = { shipFrom, ebay };
  return NextResponse.json(status);
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const validation = validateShipFrom(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "Check the highlighted fields.", fieldErrors: validation.errors },
      { status: 400 }
    );
  }

  await saveShipFromLocation(user.id, validation.value);

  // eBay connected but no merchant location yet → create it now from the
  // address we just saved. Failure here is reported, not fatal: the address
  // is stored and publish-time ensureEbayLocation retries the chain.
  let ebayLocation: { status: "ready" | "pending" | "error"; message?: string } =
    { status: "pending" };
  try {
    const conn = await getConnection(user.id, "ebay");
    if (!conn) {
      ebayLocation = { status: "pending" };
    } else if (conn.meta.merchantLocationKey) {
      ebayLocation = { status: "ready" };
    } else {
      await ensureEbayLocation(conn, validation.value);
      ebayLocation = { status: "ready" };
    }
  } catch (err) {
    // Most commonly eBay rejecting the address — surface its message so the
    // seller can fix the field, never a config error.
    ebayLocation = {
      status: "error",
      message:
        err instanceof Error
          ? err.message
          : "eBay rejected the address — double-check it and save again.",
    };
  }

  return NextResponse.json({ ok: true, ebayLocation });
}
