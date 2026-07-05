// Erasure hook for eBay Marketplace Account Deletion notifications.
//
// When eBay tells us one of their users deleted their account, we must delete
// or anonymize everything we store that is tied to that user. This module is
// the single place that responsibility lives, so the route handler stays thin
// and the compliance surface is auditable in one file.
//
// What we currently store that could reference an eBay user:
//   - platform_connections (Phase 1): the *seller's own* OAuth tokens for eBay.
//     We don't yet persist the eBay userId on that row, so we can't match by it
//     today — see the TODO below. We store no eBay *buyer* PII at all.
//
// As the product grows (order imports, buyer messaging, saved eBay profiles),
// every new store of eBay-user data MUST be wired into this function.

export interface EbayDeletionRequest {
  // eBay's stable account id for the deleted user (their "userId").
  userId: string | null;
  // The public username, if provided.
  username: string | null;
  // For log correlation with the received webhook.
  notificationId: string;
}

/**
 * Delete / anonymize all stored data for a deleted eBay user.
 *
 * Must be safe to call more than once (eBay re-sends on non-2xx), so every
 * step here is idempotent.
 *
 * TODO(compliance): once platform_connections stores the eBay userId at
 * connect time (add `meta.ebayUserId` in lib/platforms/ebay.ts:ebayExchangeCode
 * via a GET /commerce/identity/v1/user call), match and purge the connection
 * here, e.g.:
 *
 *   const supabase = getSupabaseAdmin();
 *   await supabase
 *     .from("platform_connections")
 *     .delete()
 *     .eq("platform", "ebay")
 *     .eq("meta->>ebayUserId", req.userId);
 *
 * Until then this is a logged no-op: we hold no other eBay-user-scoped data.
 */
export async function handleEbayAccountDeletion(
  req: EbayDeletionRequest
): Promise<void> {
  console.log(
    `[ebay-deletion] Processing erasure for eBay userId=${
      req.userId ?? "unknown"
    } (notification ${req.notificationId})`
  );

  // No eBay-user-scoped data to purge yet. Kept async so wiring real deletes in
  // later is a drop-in change with no signature churn.
  await Promise.resolve();
}
