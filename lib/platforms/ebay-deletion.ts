// Erasure hook for eBay Marketplace Account Deletion notifications.

import { getSupabaseAdmin } from "@/lib/connections";

export interface EbayDeletionRequest {
  userId: string | null;
  username: string | null;
  notificationId: string;
}

export interface EbayDeletionResult {
  deletedConnections: number;
}

async function deleteConnectionsByMeta(
  key: "ebayUserId" | "ebayUsername",
  value: string
): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("platform_connections")
    .delete()
    .eq("platform", "ebay")
    .eq(`meta->>${key}`, value)
    .select("user_id");
  if (error) {
    throw new Error(`eBay connection erasure failed: ${error.message}`);
  }
  return data?.length ?? 0;
}

/** Idempotently remove every stored connection tied to the deleted account. */
export async function handleEbayAccountDeletion(
  req: EbayDeletionRequest
): Promise<EbayDeletionResult> {
  let deletedConnections = 0;

  if (req.userId) {
    deletedConnections += await deleteConnectionsByMeta("ebayUserId", req.userId);
  }
  // Username is a compatibility fallback for connections created before the
  // immutable id was captured. It is mutable, so never prefer it over userId.
  if (deletedConnections === 0 && req.username) {
    deletedConnections += await deleteConnectionsByMeta(
      "ebayUsername",
      req.username
    );
  }

  console.info(
    `[ebay-deletion] erased ${deletedConnections} connection(s) for notification ${req.notificationId}`
  );
  return { deletedConnections };
}
