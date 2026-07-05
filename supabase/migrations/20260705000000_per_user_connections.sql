-- Auth foundation: marketplace connections become per-user.
--
-- Phase 1 keyed connections by platform only (single shared beta seller).
-- With Supabase Auth in place, each user owns their own eBay/Etsy
-- connections: (user_id, platform) is the new primary key.
--
-- Pre-launch recreate: the Phase 1 table held at most one seller's tokens
-- with no owning user to attribute them to — that seller simply reconnects
-- after this deploys. No production sellers exist yet.

drop table if exists public.platform_connections;

create table public.platform_connections (
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('ebay', 'etsy')),
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, platform)
);

-- RLS on with NO policies: tokens are readable only by the service role,
-- never by the anon/authenticated browser roles. (Launch roadmap security
-- rule: no marketplace access tokens in client-readable columns.)
alter table public.platform_connections enable row level security;
