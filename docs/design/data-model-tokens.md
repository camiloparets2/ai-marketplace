# ADR: `platform_connections` is the canonical marketplace-token store

**Status:** Accepted · 2026-07-07
**Decision owner:** Camilo (resolves the design flag raised on PR #4)

## Decision

Marketplace OAuth credentials (eBay, Etsy, Shopify) are stored in
**`public.platform_connections`** and nowhere else:

```sql
platform_connections (
  user_id      uuid  references auth.users, -- owning seller
  platform     text  check in ('ebay','etsy','shopify'),
  access_token text,
  refresh_token text,
  expires_at   timestamptz,
  meta         jsonb,                        -- e.g. Shopify shop domain, Etsy shop_id
  primary key (user_id, platform)
)
```

Security posture: RLS enabled with **no policies**, and all grants revoked
from `anon`/`authenticated` — the table is reachable only through the
service-role key inside server code (`lib/connections.ts`). Tokens never
reach the browser in any form.

## The name `marketplace_accounts` is retired

Some planning documents (the July-5 prototype's vocabulary, echoed in the
launch roadmap's data-model sketch) call this concept `marketplace_accounts`.
**Do not reintroduce that name.** As of this ADR:

- No code, type, query, migration, or test in this repository references
  `marketplace_accounts` (repo-wide grep: zero hits).
- The live database has no table by that name either. (It does contain a
  *prototype* table `marketplace_connections` — a different, superseded
  schema from the July-5 build, kept read-only for salvage; the launch app
  never touches it.)

## Why we are not renaming

Renaming a live, RLS-locked table that every publish/refresh/sync path
reads — purely to match planning-doc vocabulary — buys nothing and risks a
production credential-store outage. The vocabulary moves to the table, not
the other way around. Future briefs and design docs should say
`platform_connections`.

## When this ADR gets revisited

Multi-account-per-marketplace (roadmap Phase 3 follow-up) will widen the
primary key to `(user_id, platform, account_id)`. That change extends this
table; it is not a license to rename it.
