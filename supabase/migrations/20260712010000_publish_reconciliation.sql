-- Persist-before-publish (launch-hardening Phase 1.3): a publish attempt row
-- now exists BEFORE any external marketplace call ('pending'), and a live
-- listing whose local recording failed is stamped 'reconciliation_required'
-- together with the platform-side identifiers needed to re-adopt it — a live
-- listing must never become unmanaged.

alter table public.publish_attempts
  drop constraint if exists publish_attempts_status_check;
alter table public.publish_attempts add constraint publish_attempts_status_check
  check (status in (
    'pending',
    'live',
    'assist',
    'not_connected',
    'error',
    'reconciliation_required'
  ));

-- Platform-side identifiers captured on completion — the recovery handle for
-- reconciliation (eBay listingId/offerId/sku, Etsy listing/shop, Stripe link).
alter table public.publish_attempts
  add column if not exists external_id text;
alter table public.publish_attempts
  add column if not exists url text;
alter table public.publish_attempts
  add column if not exists meta jsonb not null default '{}'::jsonb;
