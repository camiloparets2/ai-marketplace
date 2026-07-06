# TODOS

## Consumer-Launch Checklist (code is ready — this list gets you to advertising)

Everything below is configuration/ops, not code. Work top to bottom.

### [~] 1. Apply all migrations + set all env vars — DATABASE HALF DONE
**Done (2026-07-06, via the Supabase connector):** all six launch migrations are applied and registered on the production project (`eunnwzggubyhvvatxnyy` / "camiloparets2's Project"): per-user connections, billing + credits (with atomic spend/refund functions), inventory, sync_state, shopify, rate_limits. Three conflicting tables from the July-5 prototype build were renamed to `legacy_*` (16 test inventory rows preserved — delete `legacy_inventory_items`, `legacy_marketplace_listings`, `legacy_publish_attempts` whenever you're done with them). Note: this Supabase project is shared with the la_patrona OSHA app and the older prototype tables (`marketplace_connections`, `seller_profiles`, `listing_drafts`, `listings_log`, `sale_events`, `inventory_sync_actions`) — none were touched.
**Still to do:** (a) run `supabase/migrations/20260706500000_revoke_browser_role_grants.sql` (security hardening; the connector stream kept dropping on this one call), (b) enable "leaked password protection" in Supabase → Authentication (advisor recommendation, dashboard toggle), (c) fill every var in `.env.example` into the Vercel panel.

### [ ] 2. Auth + email
Google provider, Site/redirect URLs, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and **production SMTP** (Supabase's built-in sender is rate-limited to a handful/hour — not enough for real signups).

### [ ] 3. Billing live-mode test
Stripe webhook endpoint + `STRIPE_WEBHOOK_SECRET`, then one end-to-end test-mode then live-mode subscription. **Prices are decided** (Starter $9.99/60 · Pro $24.99/250 · Power $59.99/750 — full margin/value analysis in `docs/pricing-analysis.md`); adjust only if launch data says so.

### [ ] 4. Marketplace approvals
eBay production keyset (test in SANDBOX first), Etsy API key, Shopify app credentials. Reconnect any early-connected accounts (new OAuth scopes for sale polling).

### [ ] 5. Error monitoring + product analytics
Add Sentry (or Vercel's error monitoring) for auth/AI/marketplace/Stripe failures, and PostHog for the core funnel (photo → draft → publish → sale). Roadmap Gate 2 requirement; currently only console logs + Vercel logs exist.

### [ ] 6. Ops basics before ads
Supabase backup schedule (PITR or daily dumps), a rollback note (Vercel instant rollback + `git revert`), spend alerts: Anthropic ($25 soft/$50 hard — see Phase 1 list), Stripe email alerts, Vercel usage alerts.

### [ ] 7. Legal review — drafts upgraded to launch-grade; attorney sign-off remains
/privacy and /terms are now full-coverage drafts (data categories, AI disclosure, user rights, subscriptions/refunds, acceptable use, marketplace disclaimers, liability cap, termination) accurate to how the app actually behaves. Remaining before large-scale paid launch: (a) a licensed attorney's confirmation pass, (b) pin the governing-law state in Terms §11 (currently phrased as "the state in which the operator resides"), (c) re-check when new data stores or countries are added.

### [ ] 8. Mobile app — PWA shipped; store wrapper optional later
The site is now an installable app (manifest + icons + standalone display + bottom tab bar). Strategy and the Capacitor store-wrapper path: `docs/mobile-app.md`. Nothing blocking launch here.

### [ ] 9. Advertise
The ad destination is `/welcome` (public landing, OG tags set). Good first channels: reseller communities (r/Flipping, r/eBaySellerAdvice), TikTok/Reels demo of snap→listed-everywhere, and Google Ads on "crosslisting app" keywords. Track signups via PostHog before spending.

## Phase 3 Follow-ups (Shopify + channel hub are built — these complete the phase)

### [ ] Create the Shopify app and set credentials
**What:** partners.shopify.com → create an app (or a custom app on your store) → set the allowed redirection URL to `https://ai-marketplace-teal.vercel.app/api/oauth/shopify/callback` → put the client id/secret in `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` on Vercel. Then connect from `/channels` (enter the `.myshopify.com` domain).
**Why:** Shopify publishing, delisting, and sales polling are live in code but inert without app credentials. Also run `supabase db push` (widens the platform check constraints).

### [ ] Multi-account per marketplace
**What:** Allow e.g. two eBay accounts per user: `platform_connections` PK becomes (user_id, platform, account_id), publish targets carry a connection choice, channel hub lists accounts per platform. Deferred deliberately — deep refactor, low value for solo sellers; labeled "on the roadmap" in the /channels UI.

### [ ] Shopify product import (storefront → SnapToList)
**What:** Roadmap Phase 3 wants two-way flow: import existing Shopify products into inventory. Export (SnapToList → Shopify) ships now; import is the follow-up.

## Inventory Follow-ups (Phase 2 core is built — these complete it)

### [ ] Apply the inventory migration
**What:** `supabase db push` — applies `20260706100000_inventory.sql` (inventory_items, marketplace_listings, publish_attempts). Until applied, publishes still work but nothing is recorded (logged warning) and `/inventory` shows empty.

### [x] eBay/Etsy sale polling — BUILT (activation steps below)
**Built:** `lib/order-sync.ts` polls eBay `getOrders` + Etsy `getShopReceipts`, matches sales to open listings (by listing id, SKU fallback), and routes through `markItemSold` → cross-channel delisting. Triggers: daily Vercel Cron (`vercel.json` → `/api/sync/orders`), opportunistic sync on inventory load (throttled 10 min), and a manual "Check for new sales" button.
**To activate:**
1. `supabase db push` (adds the `sync_state` table).
2. Set `CRON_SECRET` in Vercel (any random string) so the cron sweep authenticates.
3. **Reconnect eBay and Etsy accounts** connected before this shipped — sale polling needs the new `sell.fulfillment` (eBay) and `transactions_r` (Etsy) OAuth scopes.
4. Hobby plan runs the cron daily; on Vercel Pro, tighten `vercel.json` to hourly (`"23 * * * *"`) for a smaller oversell window. Active sellers get 10-minute-grade sync from the inventory-load trigger regardless.

### [ ] Inventory item detail + edit
**What:** Item detail page with editable cost of goods, purchase source, storage location, notes (columns already exist), plus listing history. Then profit per sale = sold_price − cost_of_goods − fees (Phase 4 analytics feed off this).

## Billing Follow-ups (subscriptions + credits are built — these finish the rollout)

### [ ] Create the Stripe webhook endpoint
**What:** Stripe Dashboard → Developers → Webhooks → Add endpoint: `https://ai-marketplace-teal.vercel.app/api/billing/webhook`, events `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` in Vercel. Test with `stripe listen --forward-to localhost:3000/api/billing/webhook` locally.
**Why:** Without it, checkouts succeed but subscriptions never sync and credits are never granted.

### [ ] Apply the billing migration before enabling checkout
**What:** `supabase db push` — applies `20260706000000_billing_credits.sql` (tables + atomic spend/refund functions). Until applied, credit gating fails open (logged warning) so the product keeps working — but nothing is metered.

### [x] Confirm final plan prices — DECIDED
**Decision:** Starter $9.99/60 · Pro $24.99/250 · Power $59.99/750. Unit economics, competitor comparison, and the time-saved fairness analysis: `docs/pricing-analysis.md`. `resolvePriceId` now verifies Stripe price amounts against the catalog and re-mints (transferring the lookup key) on change, so future price edits are a one-line change in `lib/billing/plans.ts`.

### [ ] Run one live-mode end-to-end billing test
**What:** Test-mode first (test card 4242…), then live: subscribe → webhook grants credits → burn a credit on an AI draft → cancel via portal → verify access-until-period-end. Roadmap Gate 2/3 requirement.

## Auth Foundation Follow-ups (auth is built — these finish the rollout)

### [ ] Configure Supabase Auth in production
**What:** In Supabase → Authentication: enable the Google provider (paste Google Cloud OAuth Client ID/Secret; the Google app's redirect URI is `https://<PROJECT_REF>.supabase.co/auth/v1/callback`), set Site URL to `https://ai-marketplace-teal.vercel.app`, and add redirect URLs for `/auth/callback` (prod + localhost, with and without `?next=`). Set `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel. Full checklist: docs/launch-roadmap.md → "Authentication And Account Recovery".
**Why:** The login page, Google button, and password reset are live in code but inert until the provider + URLs are configured.

### [ ] Apply the per-user connections migration
**What:** `supabase db push` — applies `20260705000000_per_user_connections.sql`, which recreates `platform_connections` keyed by (user_id, platform). Any Phase 1 connection must be reconnected once signed in.
**Why:** Marketplace connections are now owned by user accounts.

### [ ] Configure production SMTP for auth emails
**What:** Supabase → Authentication → SMTP: connect a real sender (Resend/Postmark/SES). Supabase's built-in email is rate-limited to a handful of messages per hour — fine for testing, not for beta users resetting passwords.

### [ ] Remove the legacy beta key at Gate 2
**What:** Delete `APP_INTERNAL_BETA_KEY` / `NEXT_PUBLIC_APP_INTERNAL_BETA_KEY`, the fallback in `lib/auth/guard.ts`, and the `x-api-key` headers in `app/page.tsx` once all beta sellers have accounts.
**Why:** The key predates real auth; it carries no user identity and shouldn't outlive the transition.

## Phase 2 Launch Blockers (multi-platform publishing is built — these unblock it)

### [ ] Finish eBay Developer Program approval + configure OAuth
**What:** Complete the developer.ebay.com application (below), then create a keyset, set the OAuth "accepted" URL to `{APP_URL}/api/oauth/ebay/callback`, and fill `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_POSTAL_CODE` in Vercel. Test end-to-end with `EBAY_ENV=SANDBOX` first.
**Why:** The eBay publish pipeline (`lib/platforms/ebay.ts`) is live-ready but cannot run without credentials.

### [ ] Apply for an Etsy Open API v3 key
**What:** Request an API key at etsy.com/developers ("commercial" access for a listing tool), set the redirect URI to `{APP_URL}/api/oauth/etsy/callback`, fill `ETSY_API_KEY`.
**Why:** Etsy publishing (`lib/platforms/etsy.ts`) is built and waiting on the key. Etsy approval usually takes days, not weeks.
**Note:** Etsy policy allows handmade/vintage/craft supplies — general resale items belong on eBay/FB/OfferUp, not Etsy. The `ETSY_WHO_MADE`/`ETSY_WHEN_MADE` env defaults assume vintage resale.

### [ ] Apply the platform_connections migration + verify Supabase env vars
**What:** `supabase db push` (or run `supabase/migrations/20260702000000_platform_connections.sql` in the SQL editor); set `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
**Why:** OAuth tokens and hosted listing photos both live in Supabase; without it, eBay/Etsy connect flows fail with a clear config error.

### [ ] Facebook Marketplace / OfferUp: revisit API access quarterly
**What:** Facebook only exposes Marketplace listing APIs to approved Commerce Platform partners; OfferUp has no public API. The app ships an assisted-post flow (copy + photo + deep link) for both. Re-check partner program availability quarterly; if approved, swap the assist flow for a live publish in `lib/platforms/`.

## Phase 1 Parallel Actions (do while building this weekend)

### [ ] Apply for eBay Developer Program
**What:** Apply at developer.ebay.com for sandbox credentials and API access.
**Why:** eBay API approval takes 1-3 weeks (policy review). If you wait until Phase 2, publishing gets delayed by up to a month after validation passes. Start the clock now.
**How to apply:** Create developer account, describe use case ("AI-assisted listing tool for individual sellers, reading/writing eBay listings via Trading API"), request Production access.
**Effort:** ~1 hour.
**Depends on:** Nothing. Do in parallel with Phase 1 build.

### [ ] Set Anthropic API spend alerts before sharing the Vercel URL
**What:** In console.anthropic.com → Billing → Usage limits: set soft alert at $25/month, hard limit at $50/month.
**Why:** API key leak or accidental URL sharing creates unbounded cost exposure. A spend alert catches runaway usage before it becomes a surprise bill.
**Effort:** 5 minutes.
**Depends on:** Nothing. Do before handing out the URL to test sellers.

---

## Phase 2 Research Questions (after validation data is in)

### [ ] Calibrate or challenge the confidence threshold
**What:** Analyze the Phase 1 Google Sheet validation data: for extractions that were wrong, what was Claude's reported confidence value? Is the 60% threshold well-calibrated, or do high-confidence extractions have meaningful false-positive rates?
**Why:** Claude generates spec values AND confidence scores in the same inference pass. Self-reported confidence is not ground-truth validated. The "needs review" yellow indicator implies confidence > 60 means "trust it" — this may not hold. Returns from wrong specs are the problem this product solves.
**How:** Add a column to the Phase 1 Google Sheet: "Was the extraction wrong despite confidence > 60?" Track frequency. If > 10% of high-confidence extractions are wrong, lower the threshold or add a blanket "AI-generated — always verify" disclaimer.
**Depends on:** Phase 1 validation data (30 test listings).

### [ ] Add Upstash Redis rate limiting
**What:** Replace the Phase 1 API key header protection with proper per-IP rate limiting using @upstash/ratelimit + Upstash Redis.
**Why:** lru-cache rate limiting is broken on Vercel serverless (stateless, multi-instance). API key is fine for 10 known sellers but won't scale when the URL goes semi-public in Phase 2.
**How:** `npm install @upstash/ratelimit @upstash/redis` → connect Upstash via Vercel integration → 3-line rate limiter in `/api/analyze`.
**Depends on:** Phase 2 public URL distribution.
