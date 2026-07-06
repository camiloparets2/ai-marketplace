// The signed-in user's inventory: items with their marketplace listings.
// Opening inventory also kicks off an opportunistic sale sync (throttled,
// post-response via after()) so active sellers get near-real-time oversell
// protection without waiting for the daily cron.

import { NextResponse, after } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { listInventory } from "@/lib/inventory";
import {
  syncUserSales,
  lastAnySyncAt,
  OPPORTUNISTIC_MIN_INTERVAL_MS,
} from "@/lib/order-sync";

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await listInventory(user.id);

    // Post-response sale sync — never delays or fails the page.
    after(async () => {
      try {
        const last = await lastAnySyncAt(user.id);
        if (!last || Date.now() - last.getTime() > OPPORTUNISTIC_MIN_INTERVAL_MS) {
          await syncUserSales(user.id);
        }
      } catch (err) {
        console.warn("[inventory] opportunistic sync skipped:", err);
      }
    });

    return NextResponse.json({ items });
  } catch (err) {
    console.error("[inventory] list failed:", err);
    // Migration not applied yet → empty inventory beats a broken page.
    return NextResponse.json({ items: [] });
  }
}
