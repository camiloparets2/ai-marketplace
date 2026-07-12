-- Repair the seller_profiles name collision (docs/design/ship-from-location.md).
--
-- This database carries prototype-era tables. A legacy public.seller_profiles
-- (id PK, stripe_account_id, ebay_* token columns — no user_id, no ship-from
-- columns) predated 20260711000000_seller_profiles.sql, whose
-- `create table if not exists` matched on NAME and silently did nothing.
-- The app then failed at runtime: "column seller_profiles.ship_from_country
-- does not exist". No code on master reads the legacy columns (tokens live
-- in platform_connections), so the legacy table is dead weight.
--
-- IDEMPOTENT by design: production was already repaired by hand, so every
-- step below must be a harmless no-op there and on any fresh environment.
-- The earlier migration stays untouched — migrations are append-only.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'seller_profiles'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'seller_profiles'
      and column_name = 'ship_from_country'
  ) then
    alter table public.seller_profiles rename to legacy_seller_profiles;
  end if;
end $$;

-- lock down the legacy table if it now exists
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'legacy_seller_profiles'
  ) then
    execute 'alter table public.legacy_seller_profiles enable row level security';
    execute 'revoke all on table public.legacy_seller_profiles from anon, authenticated';
  end if;
end $$;

create table if not exists public.seller_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ship_from_country char(2) not null check (ship_from_country ~ '^[A-Z]{2}$'),
  ship_from_postal_code text check (ship_from_postal_code is null or char_length(ship_from_postal_code) between 1 and 16),
  ship_from_city text check (ship_from_city is null or char_length(ship_from_city) between 1 and 80),
  ship_from_state_or_province text check (ship_from_state_or_province is null or char_length(ship_from_state_or_province) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.seller_profiles enable row level security;
revoke all on table public.seller_profiles from anon, authenticated;
