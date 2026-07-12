# ⚠ Supabase project isolation — blast radius and recommendation

Status: flagged · Owner: Camilo · 2026-07-12

## The situation

Snap to List shares its Supabase project (`eunnwzggubyhvvatxnyy`) with an
**unrelated OSHA application** (tables: `inspections`, `inspection_types`,
`corrective_actions`) and with prototype-era leftovers (`la_patrona`,
`legacy_*`, `marketplace_connections`, `listing_drafts`, `listings_log`,
`sale_events`, `inventory_sync_actions`).

**Rule for all Snap to List work: never read, write, migrate, grant, or
revoke on the OSHA or legacy tables.** Migrations in this repo name their
tables explicitly and never use wildcard DDL against `public` (the one
exception — `alter default privileges` in the Data-API grants migration —
affects only FUTURE tables' default grants, not existing OSHA data).

## Blast radius of staying shared

| Vector | Consequence |
|---|---|
| One Postgres instance | A runaway Snap to List query (poll sweep, analytics) degrades OSHA and vice versa; connection-pool exhaustion is shared. |
| One auth realm | `auth.users` is shared: Snap to List's trial-grant trigger fires for OSHA signups; account deletion/erasure logic has to be careful never to touch OSHA users' rows. |
| One service-role key | Any Snap to List server bug or key leak exposes OSHA data too — the key is root on BOTH apps' tables. |
| One storage quota / rate limit | The `listing-photos` bucket (public) shares the storage plan and egress with OSHA files. |
| One dashboard of settings | Auth settings (leaked-password protection, SMTP, redirect URLs) are project-global — a change for one app silently applies to the other. |
| Migration collisions | Already happened once: prototype `seller_profiles` collided by NAME with the real migration and silently no-opped (repaired 2026-07-11, PR #22/#25). Shared namespaces invite repeats. |
| Backups/restore | Point-in-time restore is all-or-nothing: rolling back a Snap to List incident rolls back OSHA data with it. |

## Recommendation

**Create a dedicated Supabase project for Snap to List before scale /
advertising** (Phase 7 gate). Sequence:

1. Create the new project; apply `supabase/migrations/` from scratch (they
   are clean for a fresh database, including the idempotency repairs).
2. Recreate the `listing-photos` bucket (public) and storage policies.
3. Move env vars (`NEXT_PUBLIC_SUPABASE_URL`, anon key, service-role key) in
   Vercel; redeploy.
4. Migrate data: `auth.users` export/invite flow for beta users, then the
   Snap to List tables only (`platform_connections`, billing tables,
   `inventory_items`, `marketplace_listings`, `publish_attempts`,
   `sold_events`, `pipeline_audit`, `price_history`, `sync_state`,
   `app_events`, `rate_limits`, `notification_receipts`, `seller_profiles`).
5. Re-run `GET /api/health` + the Supabase advisors on the new project.
6. Decommission Snap to List tables in the shared project after a soak week.

Until then: keep RLS-on/no-policies + revoked browser grants on every Snap
to List table (the standing pattern), and treat every migration as if OSHA
production data sits one typo away — because it does.
