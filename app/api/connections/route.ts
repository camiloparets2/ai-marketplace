// Reports which marketplaces are connected so the UI can render
// "Connect eBay" vs a ready-to-publish checkbox.

import { NextRequest, NextResponse } from "next/server";
import { getConnection } from "@/lib/connections";
import { API_PLATFORMS } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";

export interface ConnectionsResponse {
  // Only API platforms appear here — assist platforms need no connection.
  connections: Record<ApiPlatform, boolean>;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const incomingKey = req.headers.get("x-api-key");
  if (
    !process.env.APP_INTERNAL_BETA_KEY ||
    incomingKey !== process.env.APP_INTERNAL_BETA_KEY
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connections = {} as Record<ApiPlatform, boolean>;
  for (const platform of API_PLATFORMS) {
    try {
      connections[platform] = (await getConnection(platform)) !== null;
    } catch {
      // Supabase not configured yet — report disconnected rather than erroring
      // so the UI (and the assist platforms) still work.
      connections[platform] = false;
    }
  }

  return NextResponse.json({ connections } satisfies ConnectionsResponse);
}
