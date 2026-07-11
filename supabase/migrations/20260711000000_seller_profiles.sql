-- Seller profiles: per-user ship-from location (docs/design/ship-from-location.md).
--
-- Publishing to eBay requires a merchant inventory location. That address is
-- per-seller data — sellers live all over the world — so it can never be a
-- deploy-level env var (the old EBAY_POSTAL_CODE, now deprecated).
--
-- Global correctness:
--   * country is ISO 3166-1 alpha-2 and always required.
--   * postal_code is nullable — some countries have no postal codes, and
--     formats vary (GB "SW1A 1AA", DE "10115"); no US-ZIP assumptions.
--   * city / state_or_province cover the countries where eBay needs
--     city+stateOrProvince instead of a postal code.
-- Validation lives in lib/ship-from.ts; the DB only enforces shape.
--
-- The eBay merchantLocationKey (and derived marketplace/currency) is stored
-- per connection in platform_connections.meta, same as Etsy shopId — no
-- connection-table change needed.
--
-- Same security pattern as the rest of the schema: RLS on, NO policies,
-- browser-role grants revoked — service-role access only (API routes).

create table if not exists public.seller_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ship_from_country char(2) not null
    check (ship_from_country ~ '^[A-Z]{2}$'),
  ship_from_postal_code text
    check (
      ship_from_postal_code is null
      or char_length(ship_from_postal_code) between 1 and 16
    ),
  ship_from_city text
    check (ship_from_city is null or char_length(ship_from_city) between 1 and 80),
  ship_from_state_or_province text
    check (
      ship_from_state_or_province is null
      or char_length(ship_from_state_or_province) between 1 and 80
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.seller_profiles enable row level security;
revoke all on table public.seller_profiles from anon, authenticated;
