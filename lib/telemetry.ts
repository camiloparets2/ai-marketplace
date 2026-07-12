// Product event tracking (server-only) — the data layer for the launch
// funnel: sign_in → draft_created → published → item_sold.
//
// Design rules:
//   - fire-and-forget: telemetry must NEVER break or slow a product flow,
//     so every failure is swallowed with a console warning
//   - safe payloads only: ids, counts, platform names — never tokens,
//     listing text, or photos
//
// Read it with SQL (service role) until a dedicated analytics tool lands:
//   select event, count(*) from app_events
//    where created_at > now() - interval '7 days' group by 1 order by 2 desc;

import { getSupabaseAdmin } from "@/lib/connections";

// Canonical event names — keep this the single vocabulary so funnel queries
// don't chase typos.
export type AppEvent =
  | "sign_in"
  | "draft_created"
  | "draft_failed"
  | "published"
  | "publish_error"
  // draft published/retried from stored data — no AI call, no credit
  | "draft_publish"
  | "item_sold"
  | "item_delisted"
  | "credits_granted"
  | "subscription_synced"
  | "direct_sale";

export async function trackEvent(
  userId: string | null,
  event: AppEvent,
  props: Record<string, unknown> = {}
): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from("app_events").insert({
      user_id: userId,
      event,
      props,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[telemetry] ${event} not recorded:`, err);
  }
}
