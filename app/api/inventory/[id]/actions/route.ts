// Inventory item actions — the seller-facing side of the anti-oversell sync.
//
// POST body:
//   { action: "sold", platform: string, soldPrice?: number }
//       → mark sold; end listings on every other channel
//   { action: "delist" }
//       → end all listings, return the item to draft
//   { action: "archive" }
//       → archive the item (no marketplace calls)
//   { action: "set_cost", costOfGoods: number }
//       → record what the item cost — feeds profit analytics
//
// Sold/delist are idempotent: repeating retries any listing whose end failed.

export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import {
  markItemSold,
  delistItem,
  archiveItem,
  setItemCost,
} from "@/lib/inventory";
import { trackEvent } from "@/lib/telemetry";

interface ActionBody {
  action?: unknown;
  platform?: unknown;
  soldPrice?: unknown;
  costOfGoods?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "sold": {
        if (typeof body.platform !== "string" || !body.platform) {
          return NextResponse.json(
            { error: "platform is required for a sale" },
            { status: 400 }
          );
        }
        const soldPrice =
          typeof body.soldPrice === "number" && isFinite(body.soldPrice)
            ? body.soldPrice
            : null;
        const result = await markItemSold(user.id, id, body.platform, soldPrice);
        if (!result) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        await trackEvent(user.id, "item_sold", {
          itemId: id,
          platform: body.platform,
          endOk: result.ok,
        });
        return NextResponse.json(result);
      }
      case "delist": {
        const result = await delistItem(user.id, id);
        if (!result) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        await trackEvent(user.id, "item_delisted", {
          itemId: id,
          endOk: result.ok,
        });
        return NextResponse.json(result);
      }
      case "archive": {
        const ok = await archiveItem(user.id, id);
        if (!ok) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        return NextResponse.json({ ok: true, endResults: [] });
      }
      case "set_cost": {
        if (
          typeof body.costOfGoods !== "number" ||
          !isFinite(body.costOfGoods) ||
          body.costOfGoods < 0
        ) {
          return NextResponse.json(
            { error: "costOfGoods must be a non-negative number" },
            { status: 400 }
          );
        }
        const ok = await setItemCost(user.id, id, body.costOfGoods);
        if (!ok) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        return NextResponse.json({ ok: true, endResults: [] });
      }
      default:
        return NextResponse.json(
          { error: "action must be sold, delist, archive, or set_cost" },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error(`[inventory] action failed for ${id}:`, err);
    return NextResponse.json(
      { error: "Action failed. Please try again." },
      { status: 502 }
    );
  }
}
