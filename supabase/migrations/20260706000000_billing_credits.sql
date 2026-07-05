-- Billing + AI credits (launch roadmap: "Stripe Subscriptions And AI Credits").
--
-- Design:
--   billing_customers      user ↔ Stripe customer mapping
--   subscriptions          mirror of the user's Stripe subscription state
--   monthly_credit_grants  one row per billing period (or trial); available
--                          credits = credits_granted - credits_used
--   usage_ledger           one row per AI action, for audit and refunds
--   stripe_webhook_events  processed event ids → idempotent webhook handling
--
-- Atomicity: spend_credits() is a single guarded UPDATE — the row lock makes
-- concurrent spends serialize, and the WHERE clause makes overspending
-- impossible. No client-side read-modify-write anywhere.
--
-- All tables: RLS on, NO policies → service-role access only. Browser roles
-- read billing state through API routes, never the tables.

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_key text not null,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);

create table if not exists public.monthly_credit_grants (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'trial' | 'invoice' | 'manual'
  source text not null,
  -- present for invoice grants; unique blocks double-granting on webhook retries
  stripe_invoice_id text unique,
  period_start timestamptz not null,
  period_end timestamptz not null,
  credits_granted integer not null check (credits_granted > 0),
  credits_used integer not null default 0 check (credits_used >= 0),
  created_at timestamptz not null default now(),
  check (credits_used <= credits_granted)
);
create index if not exists credit_grants_user_period_idx
  on public.monthly_credit_grants (user_id, period_end desc);
-- one free trial per user, ever
create unique index if not exists one_trial_grant_per_user
  on public.monthly_credit_grants (user_id) where source = 'trial';

create table if not exists public.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  credits integer not null,
  -- 'consumed' | 'refunded'
  status text not null default 'consumed',
  -- app-generated uuid per AI call; unique makes refunds idempotent
  request_id text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists usage_ledger_user_idx on public.usage_ledger (user_id, created_at desc);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.monthly_credit_grants enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.stripe_webhook_events enable row level security;

-- Atomically consume credits from the user's active grant.
-- Returns the grant state after the spend, or no rows when there aren't
-- enough credits (or no active grant).
create or replace function public.spend_credits(p_user_id uuid, p_amount integer)
returns table (credits_granted integer, credits_used integer, period_end timestamptz)
language sql
security definer
set search_path = public
as $$
  update public.monthly_credit_grants g
     set credits_used = g.credits_used + p_amount
   where g.id = (
           select id
             from public.monthly_credit_grants
            where user_id = p_user_id
              and now() >= period_start
              and now() <  period_end
              and credits_used + p_amount <= credits_granted
            order by period_end desc
            limit 1
         )
  returning g.credits_granted, g.credits_used, g.period_end;
$$;

-- Return credits to the user's active grant (AI call failed after reserve).
-- Floors at zero; never fails.
create or replace function public.refund_credits(p_user_id uuid, p_amount integer)
returns void
language sql
security definer
set search_path = public
as $$
  update public.monthly_credit_grants g
     set credits_used = greatest(g.credits_used - p_amount, 0)
   where g.id = (
           select id
             from public.monthly_credit_grants
            where user_id = p_user_id
              and now() >= period_start
              and now() <  period_end
            order by period_end desc
            limit 1
         );
$$;

-- Functions are called with the service role key only; keep other roles out.
revoke execute on function public.spend_credits(uuid, integer) from public, anon, authenticated;
revoke execute on function public.refund_credits(uuid, integer) from public, anon, authenticated;
