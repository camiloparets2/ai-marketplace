-- Harden service-role-only tables: revoke browser-role grants so the tables
-- aren't even discoverable through the GraphQL/Data API schema. Rows were
-- already blocked by RLS-with-no-policies; this removes structure visibility
-- too (Supabase advisor lints 0026/0027). All access goes through server API
-- routes using the service role.
--
-- NOTE: the six launch migrations before this one were applied to the
-- production project (eunnwzggubyhvvatxnyy) via the Supabase connector on
-- 2026-07-06. This revoke is the only one still pending there — apply it
-- with `supabase db push` or paste into the SQL editor.

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
