// OAuth token store for marketplace connections (eBay, Etsy).
//
// Connections are per-user AND per-environment: (user_id, platform,
// environment) is the primary key. Sandbox and production share one
// Supabase project, and a token issued for one eBay environment must NEVER
// be presented to the other (a sandbox refresh token on the production
// client is 400 invalid_grant "issued to another client" — hit live).
// Every read/write here is pinned to the CURRENT EBAY_ENV, so a process
// can only ever see its own environment's tokens. Tokens live behind the
// service role only — RLS is enabled with no policies, so browser roles can
// never read this table.
//
// This module must only be imported from server code, never from components.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ApiPlatform, PlatformConnection } from "@/lib/platforms/types";
import { currentEbayEnvironment } from "@/lib/ebay-env";

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
  user_id: string;
  platform: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  meta: Record<string, string> | null;
}

export async function saveConnection(conn: PlatformConnection): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("platform_connections")
    .upsert(
      {
        user_id: conn.userId,
        platform: conn.platform,
        // Stamped from the process's own EBAY_ENV: a connection made while
        // pointed at sandbox can never overwrite the production row.
        environment: currentEbayEnvironment(),
        access_token: conn.accessToken,
        refresh_token: conn.refreshToken,
        expires_at: conn.expiresAt ? new Date(conn.expiresAt).toISOString() : null,
        meta: conn.meta,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform,environment" }
    );
  if (error) {
    throw new Error(`Failed to save ${conn.platform} connection: ${error.message}`);
  }
}

export async function getConnection(
  userId: string,
  platform: ApiPlatform
): Promise<PlatformConnection | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("platform_connections")
    .select("user_id, platform, access_token, refresh_token, expires_at, meta")
    .eq("user_id", userId)
    .eq("platform", platform)
    // Environment pinning: a production process can only load production
    // tokens (and vice versa) — cross-environment tokens are invisible.
    .eq("environment", currentEbayEnvironment())
    .maybeSingle<ConnectionRow>();

  if (error) {
    throw new Error(`Failed to read ${platform} connection: ${error.message}`);
  }
  if (!data) return null;

  return {
    userId: data.user_id,
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

/**
 * True when the seller must go through OAuth again: the token can't refresh,
 * or (eBay) the connection predates immutable-identity capture — without
 * meta.ebayUserId an account-deletion notification could never match it, so
 * the connection must be re-established with the identity scope.
 */
export function needsReconnect(conn: PlatformConnection): boolean {
  const tokenDead = isExpired(conn) && !conn.refreshToken;
  const missingEbayIdentity =
    conn.platform === "ebay" && !conn.meta.ebayUserId;
  return tokenDead || missingEbayIdentity;
}
