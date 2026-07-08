-- Harden service-role-only tables: revoke browser-role grants so the tables
-- aren't even discoverable through the GraphQL/Data API schema. Rows were
-- already blocked by RLS-with-no-policies; this removes structure visibility
-- too (Supabase advisor lints 0026/0027). All access goes through server API
-- routes using the service role.
--
-- Applied to the production project (eunnwzggubyhvvatxnyy) on 2026-07-06 as
-- remote migration 20260706203320_snap_revoke_browser_role_grants, alongside
-- the six launch migrations before it. Advisor before/after comparison lives
-- in docs/design/supabase-hardening.md.

revoke all on table
  public.platform_connections,
  public.billing_customers,
  public.subscriptions,
  public.monthly_credit_grants,
  public.usage_ledger,
  public.stripe_webhook_events,
  public.inventory_items,
  public.marketplace_listings,
  public.publish_attempts,
  public.sync_state,
  public.rate_limits
from anon, authenticated;
