-- Product analytics events (launch checklist item 5: signup tracking and the
-- photo → draft → publish → sale funnel). One row per event, written
-- server-side only; query with plain SQL until/unless PostHog is added.
-- Same security pattern as everything else: RLS on, no policies, browser
-- grants revoked.

create table if not exists public.app_events (
  id bigint generated always as identity primary key,
  -- null for anonymous/system events (e.g. beta-key usage, webhooks)
  user_id uuid references auth.users (id) on delete set null,
  event text not null,
  props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_events_event_idx
  on public.app_events (event, created_at desc);
create index if not exists app_events_user_idx
  on public.app_events (user_id, created_at desc);

alter table public.app_events enable row level security;
revoke all on table public.app_events from anon, authenticated;
