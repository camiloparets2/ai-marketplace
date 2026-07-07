// Pricing engine persistence — the pure math lives in lib/pricing-core.ts
// (re-exported here so existing imports keep working). Server-only: every
// decision is written to price_history — the answer to "why did this list
// at $X?" is always one query away.

import { getSupabaseAdmin } from "@/lib/connections";
import type { PriceDecision } from "@/lib/pricing-core";

export * from "@/lib/pricing-core";

export async function recordPriceDecision(
  userId: string,
  inventoryItemId: string,
  decision: PriceDecision
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("price_history").insert({
    user_id: userId,
    inventory_item_id: inventoryItemId,
    price: decision.price,
    floor_price: decision.floor,
    strategy: decision.strategy,
    rationale: decision.rationale,
    inputs: decision.inputs,
  });
  if (error) throw new Error(`price history insert failed: ${error.message}`);
}
