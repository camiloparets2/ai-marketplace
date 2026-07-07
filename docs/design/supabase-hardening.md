# Supabase security hardening — migration + advisor before/after

**Status:** Applied to production · 2026-07-07
**Companion ADR:** [`data-model-tokens.md`](./data-model-tokens.md) (canonical table names)

## What the hardening is

Every launch-schema table follows the same posture: **RLS enabled with no
policies** (rows unreadable by browser roles) **plus all grants revoked from
`anon` and `authenticated`** (table *structure* invisible to the GraphQL /
Data API schema — Supabase advisor lints 0026/0027). All access goes through
server API routes using the service-role key.

The RLS half ships inside each table's own migration. The grant-revoke half
is one dedicated, timestamped migration — **never a manual SQL-editor
paste**:

```
supabase/migrations/20260706500000_revoke_browser_role_grants.sql
```

It revokes all `anon`/`authenticated` grants on the 11 launch tables:
`platform_connections`, `billing_customers`, `subscriptions`,
`monthly_credit_grants`, `usage_ledger`, `stripe_webhook_events`,
`inventory_items`, `marketplace_listings`, `publish_attempts`, `sync_state`,
`rate_limits`. (`app_events`, added on PR #3, bakes the revoke into its own
migration.)

**Applied live** to project `eunnwzggubyhvvatxnyy` on 2026-07-06 via the
Supabase connector, registered remotely as
`20260706203320_snap_revoke_browser_role_grants`.

## Advisor report — before vs after

Security advisors (`get_advisors type=security`) on the production project:

### Before the revoke migration

- **WARN `pg_graphql_*_table_exposed`** (anon + authenticated) on every
  launch table — structure discoverable through the GraphQL schema even
  though RLS blocked all rows.
- **WARN `auth_leaked_password_protection`** — HaveIBeenPwned check
  disabled.
- Assorted WARNs on prototype/legacy/la_patrona tables (see below).

### After (verified 2026-07-07)

- **Launch tables: zero WARNs.** The GraphQL-exposure findings on all 11
  tables (plus `app_events`) are gone. The only remaining findings are
  **INFO `rls_enabled_no_policy`** on the 12 launch tables — that is the
  design, not a gap: RLS-on with no policies is what makes them
  service-role-only.
- **WARN `auth_leaked_password_protection`** remains — this is a
  **dashboard-only Auth setting** (Authentication → Sign In / Up → Password
  security). It cannot be set from SQL, so it is deliberately *not* coded in
  any migration. → **Manual action for Camilo.**
- **WARN `pg_graphql_authenticated_table_exposed`** remains on
  prototype-era and unrelated objects: `marketplace_connections` (+ its
  `marketplace_connections_safe` view), `seller_profiles`, `profiles`,
  `listing_drafts`, `listings_log`, `sale_events`, `inventory_sync_actions`,
  `legacy_inventory_items`, `legacy_marketplace_listings`,
  `legacy_publish_attempts`, and the la_patrona OSHA tables
  (`app_audit_logs`, `audit_logs`, `corrective_actions`, `inspection_types`,
  `inspections`).

## Why the prototype tables are deliberately deferred

The production Vercel deployment **still runs the July-5 prototype** (the
production-branch cutover to the launch build is a pending manual Vercel
setting). That prototype performs browser-side `authenticated` reads against
`marketplace_connections`, `seller_profiles`, etc. Revoking those grants
today would break the live site for no launch-schema benefit — RLS policies
already scope those rows to their owners.

**Sequencing:** flip Vercel's production branch to `master` (launch build
goes live) → confirm the prototype is retired → then ship a follow-up
migration revoking browser grants on the prototype/legacy tables (or drop
the `legacy_*` tables outright once their 16 salvage rows are no longer
needed). Tracked in `TODOS.md` item 1.

The la_patrona tables belong to a different app sharing this Supabase
project; they are out of scope for this repo and were not touched.

## Manual actions (cannot be done from code)

1. **Enable leaked-password protection** — Supabase dashboard →
   Authentication → Sign In / Up → enable "Leaked password protection".
2. **Vercel production cutover** — Settings → Git → Production Branch →
   `master`, then redeploy (this is also the gate for the deferred
   prototype-table revoke above).
