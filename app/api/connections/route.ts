// Reports which marketplaces are connected so the UI can render
// "Connect eBay" vs a ready-to-publish checkbox.

import { NextResponse } from "next/server";
import { getConnection } from "@/lib/connections";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";
import { requireUser } from "@/lib/auth/guard";

export interface ConnectionsResponse {
  // Only API platforms appear here — assist platforms need no connection.
  connections: Record<ApiPlatform, boolean>;
}

export async function GET(): Promise<NextResponse> {
  // Connections are per-user, so a beta key (no identity) can't see any.
  const user = await requireUser();

  const connections = {} as Record<ApiPlatform, boolean>;
  for (const platform of API_PLATFORMS) {
    if (!user) {
      connections[platform] = false;
      continue;
    }
    try {
      connections[platform] = (await getConnection(user.id, platform)) !== null;
    } catch {
      // Supabase not configured yet — report disconnected rather than erroring
      // so the UI (and the assist platforms) still work.
      connections[platform] = false;
    }
  }

  return NextResponse.json({ connections } satisfies ConnectionsResponse);
}
