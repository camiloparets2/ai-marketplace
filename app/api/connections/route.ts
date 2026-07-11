// Reports which marketplaces are connected so the UI can render
// "Connect eBay" vs a ready-to-publish checkbox.

import { NextResponse } from "next/server";
import { getConnection, isExpired, needsReconnect } from "@/lib/connections";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";
import { requireUser } from "@/lib/auth/guard";

export interface ConnectionHealth {
  connected: boolean;
  // access token is past (near) its expiry
  expired: boolean;
  // a refresh token is stored → expiry self-heals on next use
  canRefresh: boolean;
  // connected but expired with no way to refresh → the seller must reconnect
  needsReconnect: boolean;
}

export interface ConnectionsResponse {
  // Legacy boolean map — assist platforms need no connection, so only API
  // platforms appear. Kept for existing consumers (snap page, channels page).
  connections: Record<ApiPlatform, boolean>;
  // Richer per-platform token health for the settings screen.
  health: Record<ApiPlatform, ConnectionHealth>;
}

export async function GET(): Promise<NextResponse> {
  // Connections are per-user and never exposed without a session.
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connections = {} as Record<ApiPlatform, boolean>;
  const health = {} as Record<ApiPlatform, ConnectionHealth>;

  for (const platform of API_PLATFORMS) {
    let conn = null;
    try {
      conn = await getConnection(user.id, platform);
    } catch {
      // A connection-store outage should not expose tokens or crash the page.
      conn = null;
    }
    const connected = conn !== null;
    const expired = conn !== null && isExpired(conn);
    const canRefresh = conn?.refreshToken != null && conn.refreshToken !== "";
    const reconnectRequired = conn !== null && needsReconnect(conn);
    connections[platform] = connected && !reconnectRequired;
    health[platform] = {
      connected,
      expired,
      canRefresh,
      needsReconnect: reconnectRequired,
    };
  }

  return NextResponse.json({ connections, health } satisfies ConnectionsResponse);
}
