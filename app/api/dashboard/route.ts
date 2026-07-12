// Dashboard command center data — one call aggregating everything a reseller
// checks daily (roadmap: "Dashboard command center should show…").
// Safe metadata only; every number is scoped to the signed-in user.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getSupabaseAdmin, getConnection } from "@/lib/connections";
import { getCreditStatus } from "@/lib/billing/credits";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";

interface ItemRow {
  status: "draft" | "review" | "listed" | "sold" | "archived";
  price: number | null;
  sold_price: number | null;
  cost_of_goods: number | null;
  sold_at: string | null;
}

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Marketplace connection health
  const connections = {} as Record<ApiPlatform, boolean>;
  for (const platform of API_PLATFORMS) {
    try {
      connections[platform] = (await getConnection(user.id, platform)) !== null;
    } catch {
      connections[platform] = false;
    }
  }

  // Credits
  const credits = await getCreditStatus(user.id);

  // Inventory aggregates — tolerate the migration not being applied yet.
  let items: ItemRow[] = [];
  let endFailedCount = 0;
  let oversoldCount = 0;
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("inventory_items")
      .select("status, price, sold_price, cost_of_goods, sold_at")
      .eq("user_id", user.id);
    items = (data ?? []) as ItemRow[];

    const { count } = await supabase
      .from("marketplace_listings")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "end_failed");
    endFailedCount = count ?? 0;

    // Simultaneous-sale races that lost the stock claim: the platform order
    // exists but the item was already sold elsewhere. URGENT and manual —
    // the app never auto-cancels an order.
    const { count: oversold } = await supabase
      .from("sold_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "oversold");
    oversoldCount = oversold ?? 0;
  } catch {
    // inventory tables absent → zeros below
  }

  const byStatus = { draft: 0, review: 0, listed: 0, sold: 0, archived: 0 };
  let listedValue = 0;
  let soldValue = 0;
  let knownCost = 0;
  let soldWithCost = 0;
  for (const item of items) {
    byStatus[item.status] += 1;
    if (item.status === "listed" && item.price !== null) {
      listedValue += Number(item.price);
    }
    if (item.status === "sold" && item.sold_price !== null) {
      soldValue += Number(item.sold_price);
      if (item.cost_of_goods !== null) {
        knownCost += Number(item.cost_of_goods);
        soldWithCost += 1;
      }
    }
  }

  return NextResponse.json({
    connections,
    creditsRemaining: credits?.creditsRemaining ?? null,
    creditsRenewAt: credits?.periodEnd ?? null,
    items: byStatus,
    listedValue,
    soldValue,
    // Profit is only as good as cost-of-goods data — expose coverage so the
    // UI can be honest about it.
    knownProfit: soldValue - knownCost,
    soldWithCostCount: soldWithCost,
    soldCount: byStatus.sold,
    endFailedCount,
    oversoldCount,
  });
}
