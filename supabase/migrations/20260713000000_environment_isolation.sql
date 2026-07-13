-- Environment isolation: sandbox and production share one Supabase project,
-- and rows describing marketplace state had NO environment dimension.
-- Connecting the sandbox eBay seller OVERWROTE the production connection
-- ((user_id, platform) key), and sandbox publish rows (e.g. listing
-- 110589875643) landed where the production order-sync cron polls them.
--
-- ADDITIVE + LIVE-SAFE: every column is added with DEFAULT 'production'
-- (correct for all pre-existing rows — sandbox rows were the anomaly), so
-- old code keeps working while new code filters by its own EBAY_ENV.
-- DO NOT RUN AUTOMATICALLY — review and apply manually (Supabase MCP).

-- ── platform_connections: environment joins the primary key ────────────────
-- One row per (user, platform, environment): the sandbox and production
-- connections coexist and can never clobber each other again.

alter table public.platform_connections
  add column if not exists environment text not null default 'production'
  constraint platform_connections_environment_check
    check (environment in ('production', 'sandbox'));

-- Single atomic statement: the table is never without a primary key.
-- (Tiny table — a handful of sellers — so the lock is momentary.)
alter table public.platform_connections
  drop constraint platform_connections_pkey,
  add primary key (user_id, platform, environment);

-- ── marketplace state rows: record WHICH environment produced them ─────────

alter table public.marketplace_listings
  add column if not exists environment text not null default 'production'
  constraint marketplace_listings_environment_check
    check (environment in ('production', 'sandbox'));

alter table public.publish_attempts
  add column if not exists environment text not null default 'production'
  constraint publish_attempts_environment_check
    check (environment in ('production', 'sandbox'));

alter table public.sold_events
  add column if not exists environment text not null default 'production'
  constraint sold_events_environment_check
    check (environment in ('production', 'sandbox'));

-- The dedupe key must include environment: a sandbox order id colliding
-- with a production order id must never swallow the production event.
-- Create the replacement BEFORE dropping the old index so replay
-- deduplication never has a gap.
create unique index if not exists sold_events_dedupe_env_idx
  on public.sold_events (environment, platform, external_order_id, listing_external_id)
  nulls not distinct;
drop index if exists public.sold_events_dedupe_idx;

-- ── Known cross-contamination from the 2026-07-13 sandbox run ──────────────
-- Reclassify the sandbox listing that landed in production state so the
-- production order-sync cron stops polling real eBay for it. Scoped to the
-- one known listing id; verify with the SELECTs before/after.
--   select id, external_id, status from public.marketplace_listings
--     where external_id = '110589875643';
update public.marketplace_listings
  set environment = 'sandbox'
  where external_id = '110589875643';
update public.publish_attempts
  set environment = 'sandbox'
  where external_id = '110589875643';
