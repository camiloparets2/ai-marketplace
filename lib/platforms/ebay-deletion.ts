// Erasure hook for eBay Marketplace Account Deletion notifications.
//
// eBay compliance requirement: when eBay says one of their users deleted
// their account, we must actually erase what we hold about that eBay account
// — OAuth tokens, identity metadata, eBay listing/order identifiers, and raw
// eBay payloads. A failing endpoint can get the production keyset disabled,
// and a silent no-op is worse: it reports compliance that never happened.
//
// The only eBay users we store data about are our own sellers (their
// connected account). Matching starts from platform_connections meta:
//   - meta.ebayUserId  — the immutable id captured at OAuth (Phase 2);
//   - meta.ebayUsername — mutable fallback for connections created before
//     the id was captured; never preferred over the id.
//
// Every step is idempotent — eBay re-sends on non-2xx and duplicate
// notifications must be harmless.

import { getSupabaseAdmin } from "@/lib/connections";

export interface EbayDeletionRequest {
  // eBay's stable account id for the deleted user.
  userId: string | null;
  // The public username, if provided (mutable — fallback only).
  username: string | null;
  // For log correlation with the received webhook.
  notificationId: string;
}

export interface EbayDeletionResult {
  deletedConnections: number;
  scrubbedListings: number;
  scrubbedAttempts: number;
  scrubbedSoldEvents: number;
  scrubbedAuditRows: number;
}

async function findConnectionUserIds(
  key: "ebayUserId" | "ebayUsername",
  value: string
): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("platform_connections")
    .select("user_id")
    .eq("platform", "ebay")
    .eq(`meta->>${key}`, value);
  if (error) throw new Error(`eBay deletion lookup failed: ${error.message}`);
  return (data ?? []).map((r) => r.user_id as string);
}

// Remove every eBay identifier and raw payload stored for one app user.
// Inventory rows themselves stay (they're the seller's own item records);
// only the eBay-side identifiers and payloads are erased.
async function scrubUserEbayData(
  appUserId: string
): Promise<Omit<EbayDeletionResult, "deletedConnections">> {
  const supabase = getSupabaseAdmin();

  // Tokens + identity metadata: delete the connection row outright.
  const { error: connErr } = await supabase
    .from("platform_connections")
    .delete()
    .eq("platform", "ebay")
    .eq("user_id", appUserId);
  if (connErr) {
    throw new Error(`connection erasure failed: ${connErr.message}`);
  }

  // eBay listing identifiers on live/ended listing records.
  const { data: listings, error: listErr } = await supabase
    .from("marketplace_listings")
    .update({ external_id: null, url: null, meta: {}, last_error: null })
    .eq("platform", "ebay")
    .eq("user_id", appUserId)
    .select("id");
  if (listErr) throw new Error(`listing scrub failed: ${listErr.message}`);

  // Publish-attempt identifiers + error text (may quote eBay responses).
  const { data: attempts, error: attErr } = await supabase
    .from("publish_attempts")
    .update({ external_id: null, url: null, meta: {}, error: null })
    .eq("platform", "ebay")
    .eq("user_id", appUserId)
    .select("id");
  if (attErr) throw new Error(`attempt scrub failed: ${attErr.message}`);

  // Order identifiers + raw eBay payloads. external_order_id is NOT NULL and
  // part of a unique index, so it becomes a per-row tombstone, not a shared
  // constant.
  const { data: soldRows, error: soldReadErr } = await supabase
    .from("sold_events")
    .select("id")
    .eq("platform", "ebay")
    .eq("user_id", appUserId);
  if (soldReadErr) {
    throw new Error(`sold_events read failed: ${soldReadErr.message}`);
  }
  for (const row of soldRows ?? []) {
    const { error: soldErr } = await supabase
      .from("sold_events")
      .update({
        external_order_id: `erased:${row.id}`,
        listing_external_id: null,
        sku: null,
        raw: {},
        error: null,
      })
      .eq("id", row.id);
    if (soldErr) throw new Error(`sold_events scrub failed: ${soldErr.message}`);
  }

  // Audit detail may embed eBay listing/order ids — keep the action rows,
  // drop the identifiers.
  const { data: auditRows, error: auditErr } = await supabase
    .from("pipeline_audit")
    .update({ detail: {} })
    .eq("platform", "ebay")
    .eq("user_id", appUserId)
    .select("id");
  if (auditErr) throw new Error(`audit scrub failed: ${auditErr.message}`);

  // Sync cursors for the deleted account.
  const { error: syncErr } = await supabase
    .from("sync_state")
    .delete()
    .eq("platform", "ebay")
    .eq("user_id", appUserId);
  if (syncErr) throw new Error(`sync_state erasure failed: ${syncErr.message}`);

  return {
    scrubbedListings: listings?.length ?? 0,
    scrubbedAttempts: attempts?.length ?? 0,
    scrubbedSoldEvents: soldRows?.length ?? 0,
    scrubbedAuditRows: auditRows?.length ?? 0,
  };
}

/**
 * Delete / anonymize all stored data for a deleted eBay user. THROWS on any
 * failure — the route returns non-2xx so eBay retries until erasure sticks.
 */
export async function handleEbayAccountDeletion(
  req: EbayDeletionRequest
): Promise<EbayDeletionResult> {
  let userIds: string[] = [];
  if (req.userId) {
    userIds = await findConnectionUserIds("ebayUserId", req.userId);
  }
  if (userIds.length === 0 && req.username) {
    userIds = await findConnectionUserIds("ebayUsername", req.username);
  }

  const result: EbayDeletionResult = {
    deletedConnections: 0,
    scrubbedListings: 0,
    scrubbedAttempts: 0,
    scrubbedSoldEvents: 0,
    scrubbedAuditRows: 0,
  };
  for (const appUserId of userIds) {
    const scrubbed = await scrubUserEbayData(appUserId);
    result.deletedConnections += 1;
    result.scrubbedListings += scrubbed.scrubbedListings;
    result.scrubbedAttempts += scrubbed.scrubbedAttempts;
    result.scrubbedSoldEvents += scrubbed.scrubbedSoldEvents;
    result.scrubbedAuditRows += scrubbed.scrubbedAuditRows;
  }

  console.info(
    `[ebay-deletion] notification ${req.notificationId}: erased ${result.deletedConnections} connection(s), scrubbed ${result.scrubbedListings} listing(s), ${result.scrubbedAttempts} attempt(s), ${result.scrubbedSoldEvents} sold event(s), ${result.scrubbedAuditRows} audit row(s)`
  );
  return result;
}
