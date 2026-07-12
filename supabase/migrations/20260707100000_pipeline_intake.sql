-- Launch pipeline intake (docs/design/launch.md P0-2/P0-3):
--   1. Items now exist from the moment identification succeeds — before a
--      price exists — so `price` becomes nullable (the pricing engine or the
--      seller fills it in).
--   2. Identification facts the guardrails consume: defects + 0-1 confidence.
--   3. New lifecycle status 'review' — where items land when an auto-post
--      guardrail fails.
--   4. price_history: one row per pricing decision (price, floor, strategy,
--      rationale, inputs) — the audit trail for "why did it list at $X?".
--
-- Same security pattern as the rest of the schema: RLS on, NO policies,
-- browser-role grants revoked — service-role access only.

alter table public.inventory_items alter column price drop not null;
alter table public.inventory_items
  add column if not exists defects jsonb not null default '[]'::jsonb;
-- Overall identification confidence 0-1 from lib/ai/vision.ts.
alter table public.inventory_items
  add column if not exists id_confidence numeric(3, 2)
    check (id_confidence is null or (id_confidence >= 0 and id_confidence <= 1));

-- Production previously created the same inline check after a table rename,
-- which gave it a `...check1` suffix. Handle both histories idempotently.
alter table public.inventory_items
  drop constraint if exists inventory_items_status_check;
alter table public.inventory_items
  drop constraint if exists inventory_items_status_check1;
alter table public.inventory_items add constraint inventory_items_status_check
  check (status in ('draft', 'review', 'listed', 'sold', 'archived'));

create table if not exists public.price_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  price numeric(10, 2) not null,
  floor_price numeric(10, 2) not null,
  -- 'user_target' | 'floor_markup' | (phase 4) 'comps'
  strategy text not null,
  rationale text not null,
  -- the numbers the decision was computed from (cost basis, fees, shipping…)
  inputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists price_history_item_idx
  on public.price_history (inventory_item_id, created_at desc);

alter table public.price_history enable row level security;
revoke all on table public.price_history from anon, authenticated;
