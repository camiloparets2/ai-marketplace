// Idempotent webhook receipts — one row per eBay notification ID, written
// only after the notification was FULLY processed. Duplicates then ACK
// without reprocessing. The underlying handlers are themselves idempotent,
// so a receipts outage degrades to reprocessing, never to data loss:
// availability beats dedupe here (fail-open by design, unlike billing).

import { getSupabaseAdmin } from "@/lib/connections";

export async function notificationAlreadyProcessed(
  notificationId: string
): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_receipts")
      .select("notification_id")
      .eq("notification_id", notificationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data !== null;
  } catch (err) {
    console.warn("[receipts] lookup failed — reprocessing (idempotent):", err);
    return false;
  }
}

export async function markNotificationProcessed(
  notificationId: string,
  topic: string
): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("notification_receipts")
      .upsert(
        { notification_id: notificationId, topic },
        { onConflict: "notification_id" }
      );
    if (error) throw new Error(error.message);
  } catch (err) {
    // Missing receipt = a future duplicate gets reprocessed idempotently.
    console.warn(`[receipts] mark failed for ${notificationId}:`, err);
  }
}
