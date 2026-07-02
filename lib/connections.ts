// OAuth token store for marketplace connections (eBay, Etsy).
//
// Phase 1 is single-seller (the app is gated by one pre-shared beta key), so
// connections are keyed by platform only — one row per platform in the
// `platform_connections` table. Multi-user token storage arrives with real
// auth in Phase 2.
//
// Storage backend: Supabase (service role — this module must only be imported
// from server code, never from components).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ApiPlatform, PlatformConnection } from "@/lib/platforms/types";

let _supabase: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      );
    }
    _supabase = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supabase;
}

interface ConnectionRow {
  platform: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  meta: Record<string, string> | null;
}

export async function saveConnection(conn: PlatformConnection): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("platform_connections")
    .upsert({
      platform: conn.platform,
      access_token: conn.accessToken,
      refresh_token: conn.refreshToken,
      expires_at: conn.expiresAt ? new Date(conn.expiresAt).toISOString() : null,
      meta: conn.meta,
      updated_at: new Date().toISOString(),
    });
  if (error) {
    throw new Error(`Failed to save ${conn.platform} connection: ${error.message}`);
  }
}

export async function getConnection(
  platform: ApiPlatform
): Promise<PlatformConnection | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("platform_connections")
    .select("platform, access_token, refresh_token, expires_at, meta")
    .eq("platform", platform)
    .maybeSingle<ConnectionRow>();

  if (error) {
    throw new Error(`Failed to read ${platform} connection: ${error.message}`);
  }
  if (!data) return null;

  return {
    platform,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at ? new Date(data.expires_at).getTime() : null,
    meta: data.meta ?? {},
  };
}

// Access tokens are refreshed 5 minutes before expiry to absorb clock skew.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function isExpired(conn: PlatformConnection): boolean {
  return conn.expiresAt !== null && Date.now() > conn.expiresAt - EXPIRY_SKEW_MS;
}
