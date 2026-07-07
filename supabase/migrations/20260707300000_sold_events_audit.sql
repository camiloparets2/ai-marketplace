-- Phase 3 (docs/design/launch.md P0-6/7/8): the sync & auto-delist core.
--
--   sold_events     one normalized queue for every "it sold" signal —
--                   webhook/notification pushes AND the polling backstop both
--                   land here, deduplicated, then get processed exactly once.
--   pipeline_audit  one row per automated action (auto-publish, auto-delist,
--                   sold-event claim, out-of-stock cancel, review hold).
--   claim_item_sale the atomic DB-locked sold transition. The row lock on the
--                   guarded UPDATE serializes concurrent sales: the first
--                   committed claim wins; the loser gets won=false and takes
--                   the out-of-stock cancel path. No read-modify-write.
--
-- Security posture as everywhere else: RLS on, NO policies, browser grants
-- revoked — service-role only.

create table if not exists public.sold_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'ebay' | 'etsy' | 'shopify' | 'direct'
  platform text not null,
  -- the platform's order/receipt id
  external_order_id text not null,
  -- the platform's listing id for the sold line (matches marketplace_listings.external_id)
  listing_external_id text,
  -- Inventory-API SKU fallback match key (eBay)
  sku text,
  sale_price numeric(10, 2),
  -- 'webhook' | 'poll' | 'manual'
  source text not null,
  raw jsonb not null default '{}'::jsonb,
  -- pending → processed | oversold (claim lost) | unmatched | error
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'oversold', 'unmatched', 'error')),
  inventory_item_id uuid references public.inventory_items (id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
-- Replays of the same order line (webhook retries, poll overlap) are no-ops.
create unique index if not exists sold_events_dedupe_idx
  on public.sold_events (platform, external_order_id, listing_external_id)
  nulls not distinct;
create index if not exists sold_events_pending_idx
  on public.sold_events (status, created_at) where status = 'pending';
create index if not exists sold_events_user_idx
  on public.sold_events (user_id, created_at desc);

create table if not exists public.pipeline_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  inventory_item_id uuid references public.inventory_items (id) on delete set null,
  -- 'auto_publish' | 'auto_delist' | 'sold_event' | 'oos_cancel' | 'review_hold'
  action text not null,
  platform text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pipeline_audit_item_idx
  on public.pipeline_audit (inventory_item_id, created_at desc);
create index if not exists pipeline_audit_user_idx
  on public.pipeline_audit (user_id, created_at desc);

alter table public.sold_events enable row level security;
alter table public.pipeline_audit enable row level security;
revoke all on table public.sold_events from anon, authenticated;
revoke all on table public.pipeline_audit from anon, authenticated;

-- Atomic sold transition. A single guarded UPDATE: the row lock serializes
-- concurrent claims, and `quantity > 0` makes overselling impossible — the
-- second concurrent claim finds no matching row and returns won=false.
create or replace function public.claim_item_sale(
  p_item_id uuid,
  p_user_id uuid,
  p_platform text,
  p_price numeric
)
returns table (won boolean, remaining_quantity integer)
language sql
security definer
set search_path = public
as $$
  with claimed as (
    update public.inventory_items
       set quantity = quantity - 1,
           status = case when quantity - 1 <= 0 then 'sold' else status end,
           sold_at = case when quantity - 1 <= 0 then now() else sold_at end,
           sold_price = case when quantity - 1 <= 0 then p_price else sold_price end,
           sold_platform = case when quantity - 1 <= 0 then p_platform else sold_platform end,
           updated_at = now()
     where id = p_item_id
       and user_id = p_user_id
       and quantity > 0
       and status in ('draft', 'review', 'listed')
     returning quantity
  )
  select true as won, quantity as remaining_quantity from claimed
  union all
  select false as won, 0 as remaining_quantity
   where not exists (select 1 from claimed);
$$;

revoke execute on function public.claim_item_sale(uuid, uuid, text, numeric)
  from public, anon, authenticated;
