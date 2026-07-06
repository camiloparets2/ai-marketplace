// Order-sync trigger.
//
//   GET  — Vercel Cron: with CRON_SECRET set, Vercel calls this path with
//          `Authorization: Bearer <CRON_SECRET>`; syncs every connected user.
//   POST — signed-in user: syncs just their own sales (the "Check for new
//          sales" button on /inventory).
//
// Both paths funnel into lib/order-sync.ts, whose processing is idempotent.

export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { syncAllUsers, syncUserSales } from "@/lib/order-sync";

function isCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(
    secret && req.headers.get("authorization") === `Bearer ${secret}`
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const summary = await syncAllUsers();
    console.log(
      `[order-sync] cron: ${summary.users} users, ${summary.itemsSold} items sold`
    );
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[order-sync] cron failed:", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const results = await syncUserSales(user.id);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[order-sync] user sync failed:", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
