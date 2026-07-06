// The signed-in user's inventory: items with their marketplace listings.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { listInventory } from "@/lib/inventory";

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await listInventory(user.id);
    return NextResponse.json({ items });
  } catch (err) {
    console.error("[inventory] list failed:", err);
    // Migration not applied yet → empty inventory beats a broken page.
    return NextResponse.json({ items: [] });
  }
}
