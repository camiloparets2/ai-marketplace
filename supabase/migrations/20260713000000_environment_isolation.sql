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

-- ── Backfill: known cross-contamination from the sandbox test run ──────────
-- Every column above defaulted existing rows to 'production' — correct for
-- everything EXCEPT the rows today's sandbox run wrote into the shared DB.
-- Each block below is scoped to an explicit, known identifier. Review with
-- the SELECT above each UPDATE before applying; row counts should match.

-- (a) The clobbered eBay connection. The sandbox connect OVERWROTE the
-- production row, so the surviving row holds the SANDBOX test seller
-- (testuser_snaptolist) and sandbox tokens. It IS a sandbox connection —
-- reclassify it so the sandbox keeps using it, and production shows a clean
-- "Connect eBay" (no more presenting a sandbox refresh token to the
-- production client → 400 invalid_grant). Reconnect production eBay once
-- after applying.
--   select user_id, platform, environment, meta->>'ebayUsername' as ebay_user
--     from public.platform_connections where platform = 'ebay';
update public.platform_connections
  set environment = 'sandbox'
  where platform = 'ebay'
    and meta->>'ebayUsername' = 'testuser_snaptolist';

-- (b) The sandbox listing recorded as live in production state — the row the
-- production order-sync cron would poll REAL eBay for.
--   select id, external_id, status, environment from public.marketplace_listings
--     where external_id = '110589875643';
update public.marketplace_listings
  set environment = 'sandbox'
  where external_id = '110589875643';
update public.publish_attempts
  set environment = 'sandbox'
  where external_id = '110589875643';
update public.sold_events
  set environment = 'sandbox'
  where listing_external_id = '110589875643';

-- (c) Remaining publish attempts from the sandbox run (the failed tries:
-- fulfillment-policy 400s, missing aspects, condition rejections — they
-- carry no external_id, so (b) can't catch them). Discriminator: eBay
-- attempts by the user who owns the sandbox test connection, created since
-- sandbox testing began. ⚠ REVIEW THE WINDOW: adjust the timestamp if any
-- REAL production publish happened after it (none should — production
-- publishes were failing on the clobbered connection).
--   select id, status, error, created_at from public.publish_attempts
--    where platform = 'ebay' and created_at >= '2026-07-12T15:00:00Z'
--    order by created_at;
update public.publish_attempts
  set environment = 'sandbox'
  where platform = 'ebay'
    and environment = 'production'
    and created_at >= '2026-07-12T15:00:00Z'
    and user_id in (
      select user_id from public.platform_connections
      where platform = 'ebay'
        and meta->>'ebayUsername' = 'testuser_snaptolist'
    );
