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
  // connected but unusable without OAuth again: dead token, or an eBay
  // connection predating immutable-identity capture (deletion compliance)
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
  // Connections are per-user, so a beta key (no identity) can't see any.
  const user = await requireUser();

  const connections = {} as Record<ApiPlatform, boolean>;
  const health = {} as Record<ApiPlatform, ConnectionHealth>;

  for (const platform of API_PLATFORMS) {
    let conn = null;
    if (user) {
      try {
        conn = await getConnection(user.id, platform);
      } catch {
        // Supabase not configured yet — treat as disconnected so the UI
        // (and the assist platforms) still work.
        conn = null;
      }
    }
    const connected = conn !== null;
    const expired = conn !== null && isExpired(conn);
    const canRefresh = conn?.refreshToken != null && conn.refreshToken !== "";
    connections[platform] = connected;
    health[platform] = {
      connected,
      expired,
      canRefresh,
      needsReconnect: conn !== null && needsReconnect(conn),
    };
  }

  return NextResponse.json({ connections, health } satisfies ConnectionsResponse);
}
