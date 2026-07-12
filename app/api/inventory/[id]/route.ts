// Single-item detail + edit — the API behind /inventory/[id].
//
// GET   → full stored draft (everything the edit view shows, including the
//         shipping estimate and cost basis that feed the break-even floor)
// PATCH → update seller-editable fields. Only drafts and review-held items:
//         a live listing is edited on the marketplace, never here.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getItemDetail, updateItemDetails } from "@/lib/inventory";
import type { ItemUpdateInput } from "@/lib/inventory";

const CONDITIONS: ReadonlySet<string> = new Set([
  "New",
  "Like New",
  "Very Good",
  "Good",
  "Acceptable",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const item = await getItemDetail(user.id, id);
    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (err) {
    console.error(`[inventory] detail read failed for ${id}:`, err);
    return NextResponse.json(
      { error: "Could not load the item. Please try again." },
      { status: 502 }
    );
  }
}

interface PatchBody {
  title?: unknown;
  price?: unknown;
  condition?: unknown;
  shippingCost?: unknown;
  costOfGoods?: unknown;
}

// Validate one optional money field: absent → skip, null → clear, number ≥ 0.
function moneyField(
  value: unknown,
  name: string
): { ok: true; value?: number | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !isFinite(value) || value < 0) {
    return { ok: false, error: `${name} must be a non-negative number` };
  }
  return { ok: true, value };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: ItemUpdateInput = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      return NextResponse.json(
        { error: "Title cannot be empty" },
        { status: 400 }
      );
    }
    patch.title = body.title.trim();
  }
  if (body.price !== undefined) {
    if (
      typeof body.price !== "number" ||
      !isFinite(body.price) ||
      body.price <= 0
    ) {
      return NextResponse.json(
        { error: "Price must be a positive number" },
        { status: 400 }
      );
    }
    patch.price = body.price;
  }
  if (body.condition !== undefined) {
    if (typeof body.condition !== "string" || !CONDITIONS.has(body.condition)) {
      return NextResponse.json(
        { error: "condition must be one of: New, Like New, Very Good, Good, Acceptable" },
        { status: 400 }
      );
    }
    patch.condition = body.condition;
  }
  const ship = moneyField(body.shippingCost, "shippingCost");
  if (!ship.ok) return NextResponse.json({ error: ship.error }, { status: 400 });
  if ("value" in ship) patch.shippingCost = ship.value;
  const cost = moneyField(body.costOfGoods, "costOfGoods");
  if (!cost.ok) return NextResponse.json({ error: cost.error }, { status: 400 });
  if ("value" in cost) patch.costOfGoods = cost.value;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const updated = await updateItemDetails(user.id, id, patch);
    if (!updated) {
      return NextResponse.json(
        { error: "Only drafts and review-held items can be edited" },
        { status: 409 }
      );
    }
    const item = await getItemDetail(user.id, id);
    return NextResponse.json({ item });
  } catch (err) {
    console.error(`[inventory] update failed for ${id}:`, err);
    return NextResponse.json(
      { error: "Update failed. Please try again." },
      { status: 502 }
    );
  }
}
