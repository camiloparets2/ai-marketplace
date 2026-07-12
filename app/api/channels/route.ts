// Channel hub data — connection status, account label, and last sale-sync
// time per marketplace (roadmap: "Marketplace Connections Hub"). Safe
// metadata only: labels and timestamps, never tokens.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection, getSupabaseAdmin, needsReconnect } from "@/lib/connections";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";
import { detectEbayReadiness } from "@/lib/platforms/ebay";
import type { EbayReadiness } from "@/lib/platforms/ebay";

interface ChannelStatus {
  platform: ApiPlatform;
  connected: boolean;
  // Human label for the connected account (Shopify shop domain, Etsy shop id).
  accountLabel: string | null;
  lastSyncedAt: string | null;
  // Token health: connected but expired with no refresh token → reconnect.
  needsReconnect: boolean;
  // eBay only: publish-readiness checklist (ship-from + business policies).
  // Detect-only — this GET never mutates the seller's eBay account; fixes
  // run at connect/publish time or via POST /api/channels/ebay-readiness.
  ebayReadiness?: EbayReadiness;
}

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const channels: ChannelStatus[] = [];
  for (const platform of API_PLATFORMS) {
    let connected = false;
    let accountLabel: string | null = null;
    let reconnectNeeded = false;
    let ebayReadiness: EbayReadiness | undefined;
    try {
      const conn = await getConnection(user.id, platform);
      connected = conn !== null;
      accountLabel =
        conn?.meta.shop ?? (conn?.meta.shopId ? `shop ${conn.meta.shopId}` : null);
      // Dead token, or an eBay connection predating identity capture
      // (deletion compliance) → the seller must reconnect.
      reconnectNeeded = conn !== null && needsReconnect(conn);
      if (platform === "ebay" && conn && !reconnectNeeded) {
        ebayReadiness = await detectEbayReadiness(conn).catch(() => undefined);
      }
    } catch {
      // Supabase not configured — report disconnected.
    }

    let lastSyncedAt: string | null = null;
    try {
      const { data } = await getSupabaseAdmin()
        .from("sync_state")
        .select("last_synced_at")
        .eq("user_id", user.id)
        .eq("platform", platform)
        .maybeSingle<{ last_synced_at: string }>();
      lastSyncedAt = data?.last_synced_at ?? null;
    } catch {
      // sync_state absent — leave null.
    }

    channels.push({
      platform,
      connected,
      accountLabel,
      lastSyncedAt,
      needsReconnect: reconnectNeeded,
      ...(ebayReadiness ? { ebayReadiness } : {}),
    });
  }

  return NextResponse.json({ channels });
}
