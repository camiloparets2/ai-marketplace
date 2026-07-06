-- Order-sync bookkeeping: when each user's sales were last pulled from each
-- marketplace. Lets the poller query only the recent window (with overlap)
-- and lets /api/inventory throttle its opportunistic sync.
-- Same pattern as everything else: RLS on, no policies, service-role only.

create table if not exists public.sync_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('ebay', 'etsy')),
  last_synced_at timestamptz not null default now(),
  primary key (user_id, platform)
);

alter table public.sync_state enable row level security;
