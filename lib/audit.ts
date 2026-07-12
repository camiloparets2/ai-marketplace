// Pipeline audit trail (docs/design/launch.md P0-8): one row per automated
// action, so "why did the system do that?" is always answerable. Writes are
// best-effort — an audit failure must never break the action it describes.

import { getSupabaseAdmin } from "@/lib/connections";

export type AuditAction =
  | "auto_publish"
  | "auto_delist"
  | "sold_event"
  | "oos_cancel"
  | "review_hold"
  | "review_approve"
  | "review_reject"
  // Seller published (or retried) a stored draft — no AI, no credit.
  | "draft_publish";

export async function recordAudit(
  userId: string,
  inventoryItemId: string | null,
  action: AuditAction,
  platform: string | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("pipeline_audit").insert({
    user_id: userId,
    inventory_item_id: inventoryItemId,
    action,
    platform,
    detail,
  });
  if (error) console.error("[audit] write failed:", error.message);
}
