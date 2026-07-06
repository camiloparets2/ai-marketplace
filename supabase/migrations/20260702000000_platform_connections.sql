-- Marketplace OAuth connections (eBay, Etsy).
-- Phase 1 is single-seller: one row per platform, written only by Edge/API
-- code holding the service role key. RLS is enabled with no policies so the
-- anon key can never read tokens.

create table if not exists public.platform_connections (
  platform text primary key check (platform in ('ebay', 'etsy')),
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.platform_connections enable row level security;

-- The listing-photos storage bucket is created lazily by lib/storage.ts on
-- first publish, so no storage setup is needed here.
