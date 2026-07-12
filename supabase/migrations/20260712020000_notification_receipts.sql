-- Idempotent webhook receipts (launch-hardening Phase 1.5): one row per eBay
-- notification ID. Re-deliveries (eBay retries on non-2xx, and can duplicate)
-- are ACKed without reprocessing once a notification is recorded processed.
-- Same security posture as everything else: RLS on, NO policies, browser
-- grants revoked — service-role only.

create table if not exists public.notification_receipts (
  notification_id text primary key,
  -- e.g. 'MARKETPLACE_ACCOUNT_DELETION', 'ORDER'
  topic text not null,
  processed_at timestamptz not null default now()
);

alter table public.notification_receipts enable row level security;
revoke all on table public.notification_receipts from anon, authenticated;
grant select, insert, update, delete on table public.notification_receipts
  to service_role;
