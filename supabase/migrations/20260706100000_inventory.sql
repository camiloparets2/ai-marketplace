-- Phase 2: inventory as source of truth (launch roadmap → "Inventory As
-- Source Of Truth" + "sold-item sync and delist actions").
--
--   inventory_items       one row per physical item a seller owns
--   marketplace_listings  where that item is live; each points back to its
--                         inventory item — the anti-oversell backbone
--   publish_attempts      audit log of every publish try, success or not
--
-- Same security pattern as the rest of the schema: RLS on, NO policies —
-- service-role only; browser access goes through user-scoped API routes.

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- listing content (denormalised from the reviewed draft at publish time)
  title text not null,
  brand text,
  model text,
  upc text,
  condition text not null,
  category text,
  specs jsonb not null default '{}'::jsonb,
  photo_url text,
  -- commerce
  quantity integer not null default 1 check (quantity >= 0),
  price numeric(10, 2) not null,
  -- reseller economics (roadmap: cost of goods → profit tracking)
  cost_of_goods numeric(10, 2),
  purchase_source text,
  storage_location text,
  notes text,
  -- lifecycle: draft → listed → sold / archived
  status text not null default 'draft'
    check (status in ('draft', 'listed', 'sold', 'archived')),
  sold_at timestamptz,
  sold_price numeric(10, 2),
  sold_platform text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inventory_items_user_idx
  on public.inventory_items (user_id, created_at desc);

create table if not exists public.marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'ebay' | 'etsy' | 'direct'
  platform text not null,
  -- platform-side id: eBay listingId, Etsy listing_id, Stripe payment link id
  external_id text,
  url text,
  -- ids needed to end the listing later (eBay offerId/sku, Etsy shopId, …)
  meta jsonb not null default '{}'::jsonb,
  -- live → ended (delisted / sold elsewhere) | end_failed (retryable)
  status text not null default 'live'
    check (status in ('live', 'ended', 'end_failed')),
  price numeric(10, 2),
  last_error text,
  published_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists marketplace_listings_item_idx
  on public.marketplace_listings (inventory_item_id);
create index if not exists marketplace_listings_user_idx
  on public.marketplace_listings (user_id, published_at desc);
-- direct-sale webhook looks listings up by the Stripe payment link id
create index if not exists marketplace_listings_external_idx
  on public.marketplace_listings (platform, external_id);

create table if not exists public.publish_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  inventory_item_id uuid references public.inventory_items (id) on delete set null,
  platform text not null,
  -- mirrors the publish fan-out result statuses
  status text not null check (status in ('live', 'assist', 'not_connected', 'error')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists publish_attempts_user_idx
  on public.publish_attempts (user_id, created_at desc);

alter table public.inventory_items enable row level security;
alter table public.marketplace_listings enable row level security;
alter table public.publish_attempts enable row level security;
