// Persistence for the per-user ship-from location (seller_profiles table).
// Validation rules live in lib/ship-from.ts (pure, shared with the form).
//
// Server-only: goes through the service-role client — the table has RLS on
// with no policies, so browser roles can never touch it.

import { getSupabaseAdmin } from "@/lib/connections";
import type { ShipFromLocation } from "@/lib/ship-from";

interface SellerProfileRow {
  ship_from_country: string;
  ship_from_postal_code: string | null;
  ship_from_city: string | null;
  ship_from_state_or_province: string | null;
}

export async function getShipFromLocation(
  userId: string
): Promise<ShipFromLocation | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("seller_profiles")
    .select(
      "ship_from_country, ship_from_postal_code, ship_from_city, ship_from_state_or_province"
    )
    .eq("user_id", userId)
    .maybeSingle<SellerProfileRow>();

  if (error) {
    throw new Error(`Failed to read ship-from location: ${error.message}`);
  }
  if (!data) return null;

  return {
    country: data.ship_from_country,
    postalCode: data.ship_from_postal_code,
    city: data.ship_from_city,
    stateOrProvince: data.ship_from_state_or_province,
  };
}

export async function saveShipFromLocation(
  userId: string,
  location: ShipFromLocation
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("seller_profiles").upsert({
    user_id: userId,
    ship_from_country: location.country,
    ship_from_postal_code: location.postalCode,
    ship_from_city: location.city,
    ship_from_state_or_province: location.stateOrProvince,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(`Failed to save ship-from location: ${error.message}`);
  }
}
