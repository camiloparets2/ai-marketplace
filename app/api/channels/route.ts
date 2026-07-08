// Channel hub data — connection status, account label, and last sale-sync
// time per marketplace (roadmap: "Marketplace Connections Hub"). Safe
// metadata only: labels and timestamps, never tokens.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { getConnection, getSupabaseAdmin, isExpired } from "@/lib/connections";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";

interface ChannelStatus {
  platform: ApiPlatform;
  connected: boolean;
  // Human label for the connected account (Shopify shop domain, Etsy shop id).
  accountLabel: string | null;
  lastSyncedAt: string | null;
  // Token health: connected but expired with no refresh token → reconnect.
  needsReconnect: boolean;
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
    let needsReconnect = false;
    try {
      const conn = await getConnection(user.id, platform);
      connected = conn !== null;
      accountLabel =
        conn?.meta.shop ?? (conn?.meta.shopId ? `shop ${conn.meta.shopId}` : null);
      // Expired with no refresh token → the seller must reconnect.
      const canRefresh = conn?.refreshToken != null && conn.refreshToken !== "";
      needsReconnect = conn !== null && isExpired(conn) && !canRefresh;
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

    channels.push({ platform, connected, accountLabel, lastSyncedAt, needsReconnect });
  }

  return NextResponse.json({ channels });
}
