-- Phase 3: Shopify joins eBay and Etsy as a first-class API channel.
-- Widens the platform check constraints; all other tables key platform as
-- free text and need no change.

alter table public.platform_connections
  drop constraint if exists platform_connections_platform_check;
alter table public.platform_connections
  add constraint platform_connections_platform_check
  check (platform in ('ebay', 'etsy', 'shopify'));

alter table public.sync_state
  drop constraint if exists sync_state_platform_check;
alter table public.sync_state
  add constraint sync_state_platform_check
  check (platform in ('ebay', 'etsy', 'shopify'));
