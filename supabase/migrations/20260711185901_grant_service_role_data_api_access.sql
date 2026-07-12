-- Supabase's 2026 Data API defaults no longer grant access to newly-created
-- public tables automatically. This application accesses its data only from
-- trusted server routes with the service-role key; browser roles stay denied.

grant usage on schema public to service_role;

grant select, insert, update, delete on table
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
  public.rate_limits,
  public.app_events,
  public.price_history,
  public.sold_events,
  public.pipeline_audit
to service_role;

grant usage, select on sequence
  public.monthly_credit_grants_id_seq,
  public.usage_ledger_id_seq,
  public.publish_attempts_id_seq,
  public.app_events_id_seq,
  public.price_history_id_seq,
  public.sold_events_id_seq,
  public.pipeline_audit_id_seq
to service_role;

grant execute on function public.spend_credits(uuid, integer) to service_role;
grant execute on function public.refund_credits(uuid, integer) to service_role;
grant execute on function public.bump_rate(text, integer, integer) to service_role;
grant execute on function public.claim_item_sale(uuid, uuid, text, numeric) to service_role;

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
  public.rate_limits,
  public.app_events,
  public.price_history,
  public.sold_events,
  public.pipeline_audit
from anon, authenticated;

-- Preserve the same server-only access model for future migrations.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;
