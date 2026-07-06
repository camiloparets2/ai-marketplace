# SnapToList Launch Roadmap

This is the master plan for turning SnapToList into a must-have reseller
application: photo-first listing creation, Shopify-style marketplace
connections, official API publishing, inventory sync, direct checkout,
subscriptions, monthly AI credits, and clear launch gates.

Production site:

```text
https://ai-marketplace-teal.vercel.app
```

Related project docs:

- [eBay production readiness](./ebay-production-readiness.md)
- [eBay marketplace account deletion](./ebay-marketplace-account-deletion.md)
- [Google auth setup](./google-auth-setup.md)

Official references:

- [Etsy Authentication](https://developers.etsy.com/documentation/essentials/authentication/)
- [Etsy Listings Tutorial](https://developers.etsy.com/documentation/tutorials/listings/)
- [eBay Authorization](https://developer.ebay.com/develop/guides-v2/authorization)
- [eBay Marketplace Account Deletion](https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion)
- [Supabase Google Login](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase Password Reset](https://supabase.com/docs/guides/auth/passwords)
- [Stripe subscriptions and webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)

## Product North Star

SnapToList should become the operating system a reseller uses every day.

The promise:

```text
Take photos once. Create a strong listing. Publish everywhere. Never oversell.
Know what made money.
```

Success means a reseller can:

- Create a review-ready listing from photos in under 3 minutes.
- Publish to connected marketplaces in under 5 minutes after review.
- Connect multiple marketplace accounts like a Shopify channel hub.
- Track inventory, listing status, sales, fees, cost of goods, and profit.
- Avoid overselling by syncing sold and delisted items across channels.
- Use AI credits predictably through a monthly subscription.
- Trust that marketplace tokens, buyer data, and billing data are protected.

Primary launch metrics:

- Time from photos to review-ready draft.
- Time from draft to published marketplace listing.
- Draft-to-publish conversion rate.
- Seller connection success rate for eBay, Etsy, and future channels.
- Monthly listings created per seller.
- Sell-through rate by seller and marketplace.
- Oversell incident count.
- AI credit burn per listing.
- Paid conversion from trial/free to subscription.
- Support tickets per active seller.

## Launch Gates

### Gate 1: Private Builder Launch

Goal: Camilo can run the full workflow end to end.

- Google sign-in works in production and local development.
- Email/password sign-in works.
- Forgot password and reset password routes are implemented.
- eBay production credentials are present in Vercel Production.
- eBay account deletion endpoint passes challenge verification.
- eBay OAuth connects one real seller account.
- eBay status endpoint returns safe metadata only.
- Etsy key is configured but marked blocked until Etsy approval is active.
- New listing draft flow works with uploaded product photos.
- Draft review page shows title, description, price, category, condition,
  images, item specifics, and policy blockers.
- One controlled eBay listing publish is completed and verified.
- Direct Stripe checkout can sell a direct listing.
- Stripe webhook marks direct checkout listing sold.
- `/dashboard/setup-health` shows no launch-blocking failures.
- No API keys, OAuth tokens, refresh tokens, service role keys, or Stripe
  secrets appear in browser responses or logs.

### Gate 2: Private Reseller Beta

Goal: 5 to 10 trusted resellers can use SnapToList with supervision.

- Onboarding checklist guides sellers through auth, marketplace connections,
  billing plan, shipping defaults, first draft, and first publish.
- eBay OAuth, policies, category suggestions, and publish readiness are stable.
- Etsy approval is complete, or Etsy remains visibly marked as pending.
- Subscription checkout works in Stripe test mode, then live mode.
- Monthly AI credit grants and usage ledger are enforced.
- Users with zero AI credits cannot generate new AI drafts until renewal,
  upgrade, or optional top-up.
- Existing drafts, inventory, settings, and analytics remain accessible even
  when credits are exhausted.
- Stripe Customer Portal lets users manage payment method, plan, invoices,
  and cancellation.
- PostHog or equivalent analytics tracks core funnels.
- Error monitoring exists for auth, AI, eBay, Etsy, Stripe, and Supabase.
- Seller feedback is collected after the first listing, first sale, and first
  sync failure.

### Gate 3: Paid Beta

Goal: early sellers can pay and get reliable value.

- Live Stripe subscriptions are enabled.
- Failed payments move accounts into a clear grace or limited-access state.
- Billing webhook retries are idempotent.
- AI credit accounting is atomic and cannot be double-spent.
- eBay and Etsy publish attempts are logged and safe to retry.
- Inventory is the source of truth for all listed channels.
- Sold item sync prevents oversells for supported marketplaces.
- Users can export inventory, listings, and billing history.
- Support email, help docs, privacy policy, terms, and cancellation guidance
  are published.
- At least 10 real sellers complete a listing workflow without direct help.
- Average listing creation time is materially better than manual listing.

### Gate 4: Public Launch

Goal: SnapToList is ready for public reseller acquisition.

- eBay, Etsy, direct checkout, and subscription billing are production-stable.
- Shopify connector plan is either implemented or clearly listed as upcoming.
- Marketplace connection hub supports multi-account architecture.
- AI costs, Stripe revenue, and marketplace sync errors are observable.
- Database backups, migration process, rollback process, and incident process
  are documented.
- Rate limiting and abuse protection are live.
- Token storage is encrypted or protected by an approved vault strategy.
- Product education exists for setup, listing quality, pricing, shipping,
  marketplace connection, and troubleshooting.
- Pricing page clearly explains plan limits, AI credits, and renewal behavior.

## Marketplace Platform Vision

SnapToList should work like a marketplace channel hub. A seller connects the
places they sell, then SnapToList handles listing, inventory, and sync from one
workspace.

### Marketplace Connections Hub

Create a dedicated marketplace settings experience with:

- Connected marketplaces.
- Connection status per marketplace.
- Reconnect prompts for expired or revoked tokens.
- Multiple connected accounts per marketplace when supported.
- Default marketplace per seller.
- Per-channel publishing toggle.
- Per-channel default policies.
- Per-channel inventory sync toggle.
- Per-channel publish readiness status.
- Last successful sync timestamp.
- Last failed action and retry button.
- Safe metadata only, never raw access tokens.

Initial channels:

- eBay.
- Etsy.
- Direct Stripe checkout marketplace.

Next channels:

- Shopify store connector.
- Poshmark, Mercari, Depop, Facebook Marketplace, Whatnot, and other reseller
  platforms only when API access, terms, and compliance are clear.

### Multi-Account Support

Design for sellers who have more than one selling identity.

Examples:

- One seller connects a personal eBay account and a business eBay account.
- One seller connects multiple Etsy shops.
- One seller connects multiple Shopify stores.
- A future team account connects shared marketplaces for multiple staff.

Required model:

- A seller owns one or more workspaces.
- A workspace owns inventory.
- A workspace has many marketplace connections.
- A marketplace connection has provider, account label, account id hash,
  scopes, status, token expiry, sync settings, and safe metadata.
- A single inventory item can publish to many marketplace listings.
- Marketplace tokens stay server-side only.

### Inventory As Source Of Truth

All marketplace listings should point back to one inventory item.

Inventory item should track:

- SKU or custom label.
- Title.
- Description.
- Category hints.
- Photos.
- Quantity.
- Condition.
- Cost of goods.
- Purchase source.
- Purchase date.
- Storage location or bin.
- Listing status.
- Sale status.
- Notes.
- Measurements.
- Weight and package dimensions.
- Created, updated, listed, sold, and archived timestamps.

Marketplace listing should track:

- Inventory item id.
- Draft id.
- Marketplace.
- Marketplace connection id.
- Marketplace listing id.
- Marketplace URL.
- Status.
- Quantity.
- Price.
- Currency.
- Published timestamp.
- Last sync timestamp.
- Last error.
- Retry count.
- Delist state.

## eBay Readiness Method

Use this exact method to decide whether eBay is ready to launch.

1. Confirm Vercel Production env vars are present:
   - `EBAY_ENV`
   - `EBAY_CLIENT_ID`
   - `EBAY_CLIENT_SECRET`
   - `EBAY_RUNAME`
   - `EBAY_OAUTH_CALLBACK_URL`
   - `EBAY_MARKETPLACE_DELETION_ENDPOINT`
   - `EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN`
2. Confirm eBay Developer Portal RuName settings:
   - Display title: `SnapToList`
   - Privacy URL: `https://ai-marketplace-teal.vercel.app/privacy`
   - Auth accepted URL:
     `https://ai-marketplace-teal.vercel.app/api/ebay/oauth/callback`
   - Auth declined URL:
     `https://ai-marketplace-teal.vercel.app/connect/ebay/declined`
3. Confirm marketplace account deletion compliance:
   - Endpoint is HTTPS.
   - GET challenge returns the expected hash.
   - POST notification is accepted.
   - eBay Developer Portal test notification succeeds.
4. Log into production SnapToList with a real seller account.
5. Open `/dashboard/setup-health`.
6. Confirm Supabase, auth, eBay, database, storage, and publish readiness
   checks pass.
7. Click Connect eBay from dashboard or marketplace settings.
8. Confirm the browser redirects to eBay consent.
9. Approve seller scopes.
10. Confirm callback returns to `/connect/ebay/success`.
11. Confirm `/api/ebay/status` returns:
    - `connected: true`
    - non-expired token state
    - safe account metadata
    - no access token or refresh token
12. Load category suggestions through `/api/ebay/category-suggestions`.
13. Load seller policies through `/api/ebay/policies`.
14. Create one controlled draft from photos.
15. Confirm publish readiness blocks missing title, price, category, condition,
    images, and policies.
16. Fix draft blockers.
17. Publish once through `POST /api/publish` with `confirm: true`.
18. Confirm the eBay listing exists and opens in eBay.
19. Confirm `publish_attempts`, inventory item, and marketplace listing records
    were written safely.
20. Inspect Vercel logs for eBay errors without printing tokens.

eBay is not launch-ready until every step above passes.

## Etsy Launch Plan

Current known state:

- Etsy credentials have been added locally and to Vercel Production.
- Etsy key status from the screenshot was pending personal approval.
- The project has Etsy OAuth scaffold routes.
- Etsy publishing is not complete.

Launch blockers:

- Etsy must approve the API key.
- The exact production redirect URI must be registered in Etsy:
  `https://ai-marketplace-teal.vercel.app/api/etsy/oauth/callback`
- Etsy OAuth must be tested after approval.
- Etsy publish, image upload, policy mapping, inventory sync, and sales sync
  must be implemented.

Required Etsy work:

- Keep `ETSY_CLIENT_ID`, `ETSY_CLIENT_SECRET`, `ETSY_SHARED_SECRET`,
  `ETSY_REDIRECT_URI`, and `ETSY_SCOPES` server-side.
- Use Etsy OAuth 2.0 authorization code flow with PKCE.
- Validate state on callback.
- Store access and refresh tokens server-side only.
- Refresh Etsy tokens before expiry.
- Fetch connected Etsy user and shop id.
- Store shop/account metadata safely.
- Fetch seller taxonomy nodes.
- Fetch or guide seller setup for shipping profiles.
- Fetch readiness states for physical listings.
- Map SnapToList condition and item fields to Etsy fields:
  - `title`
  - `description`
  - `price`
  - `quantity`
  - `taxonomy_id`
  - `who_made`
  - `when_made`
  - `is_supply`
  - `materials`
  - `tags`
  - `shipping_profile_id`
  - `return_policy_id` when supported or required
- Upload listing images before activation.
- Create Etsy listings as drafts first.
- Activate only after seller confirmation.
- Record Etsy listing id and URL in marketplace listings.
- Add Etsy publish attempts with safe request and response summaries.
- Add Etsy sales polling or webhook support.
- Add Etsy auto-delist and quantity sync after sales elsewhere.
- Add Etsy-specific readiness blockers in the draft review page.

Etsy acceptance test:

- Connect Etsy account.
- Fetch shop metadata.
- Create one draft listing with photos.
- Upload images.
- Confirm listing is visible in Etsy shop manager as draft.
- Activate a controlled test listing.
- Sync listing id and URL back to SnapToList.
- End or delete the test listing.
- Confirm no secrets appear in browser output or logs.

## Shopify And Future Marketplace Connectors

Shopify is a high-value next connector because many resellers also run their
own storefronts or want a branded store independent of marketplace fees.

Shopify connector goals:

- Connect one or more Shopify stores per workspace.
- Import existing Shopify products.
- Export SnapToList inventory to Shopify products.
- Sync quantity from SnapToList inventory to Shopify.
- Pull orders from Shopify.
- Mark inventory sold or reduce quantity after Shopify sale.
- Preserve Shopify product handles, variants, images, tags, collections, and
  fulfillment status.

Future connector selection rules:

- Prioritize official API access and terms compliance.
- Prioritize marketplaces where resellers already spend time.
- Prioritize channels with real inventory and sale sync.
- Do not build brittle browser automation as a core launch dependency.
- If a marketplace cannot be officially integrated, label it as manual assisted
  and provide copy/paste/export helpers instead.

Future marketplace candidates:

- Shopify.
- Poshmark.
- Mercari.
- Depop.
- Facebook Marketplace.
- Whatnot.
- Amazon Seller Central.
- Walmart Marketplace.
- WooCommerce.
- BigCommerce.

## Authentication And Account Recovery

Google sign-in must be a launch requirement, not a nice-to-have.

Google auth checklist:

- Supabase project is active.
- `NEXT_PUBLIC_SUPABASE_URL` is present.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` is present.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only.
- Google provider is enabled in Supabase Auth.
- Google OAuth Client ID and Client Secret are saved in Supabase.
- Google Cloud OAuth app uses the Supabase callback URL:
  `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback`
- Supabase Site URL is:
  `https://ai-marketplace-teal.vercel.app`
- Supabase redirect URLs include:
  - `https://ai-marketplace-teal.vercel.app/auth/callback`
  - `https://ai-marketplace-teal.vercel.app/auth/callback?next=/dashboard`
  - `http://localhost:3000/auth/callback`
  - `http://localhost:3000/auth/callback?next=/dashboard`
- `/login -> Continue with Google -> /auth/callback -> /dashboard` works.
- `/api/auth/status` returns safe user metadata only.

Forgot password and reset password:

- Add public `/forgot-password`.
- Add link from `/login`.
- Collect email address.
- Call `supabase.auth.resetPasswordForEmail(email, { redirectTo })`.
- Use redirect target:
  `https://ai-marketplace-teal.vercel.app/auth/callback?next=/reset-password`
- Add local redirect target:
  `http://localhost:3000/auth/callback?next=/reset-password`
- Add authenticated `/reset-password`.
- Collect new password and confirmation.
- Call `supabase.auth.updateUser({ password })`.
- Redirect to `/dashboard` after successful reset.
- Show safe error messages for expired links, weak passwords, and callback
  failures.
- Configure production SMTP instead of relying on Supabase default email limits.
- Add tests for safe next-path handling and reset route behavior.

## Stripe Subscriptions And AI Credits

SnapToList should use Stripe Billing for monthly subscriptions and an internal
credit system for AI usage.

Product decision:

- Use simple fixed monthly AI credits in v1.
- Call them `SnapTokens` or `AI credits`.
- Do not expose raw model token math to sellers.
- Credits renew monthly with the subscription cycle.
- Unused credits do not roll over in v1.
- When credits hit zero, AI generation is blocked until renewal, upgrade, or
  future top-up.
- Existing drafts, inventory, marketplace connections, analytics, and account
  data remain accessible when credits are exhausted.

Example plan structure:

| Plan | Intended seller | Monthly credits | Marketplace support | Key limits |
| --- | --- | ---: | --- | --- |
| Free Trial | New tester | 10 listing drafts | eBay setup preview | No bulk tools |
| Starter | Casual reseller | 50 listing drafts | eBay, Etsy, direct | Basic analytics |
| Pro Reseller | Consistent seller | 250 listing drafts | eBay, Etsy, Shopify, direct | Bulk tools |
| Power Seller | High-volume seller | 1000 listing drafts | All supported channels | Advanced automation |

Implementation requirements:

- Add pricing page.
- Add subscribe button per plan.
- Create Stripe Checkout Session with `mode: "subscription"`.
- Store Stripe customer id against Supabase user/workspace.
- Store Stripe subscription id, price id, status, current period start/end,
  cancel-at-period-end, and plan key.
- Add Stripe Customer Portal session route.
- Add billing page with current plan, renewal date, credits remaining, invoice
  link, portal button, and cancellation state.
- Handle Stripe webhook signature verification using raw request body.
- Handle webhook events:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `customer.subscription.paused`
  - `invoice.paid`
  - `invoice.payment_failed`
- On `invoice.paid`, grant the plan's monthly credits for that billing period.
- On cancellation, keep access until period end when applicable.
- On failed payment, show a billing action banner and enter grace or limited
  access state.
- Make webhook handling idempotent by event id.

Suggested tables:

- `billing_customers`
- `subscription_plans`
- `subscriptions`
- `monthly_credit_grants`
- `usage_ledger`
- `feature_entitlements`
- `stripe_webhook_events`

Credit ledger rules:

- One ledger row per AI action.
- Track user id, workspace id, action type, credits reserved, credits consumed,
  model, request id, draft id, status, and timestamps.
- Before an AI action, atomically reserve required credits.
- If the AI call succeeds, finalize consumption.
- If the AI call fails before useful output, refund reservation.
- If the AI call partially succeeds, record actual consumed credits or one
  fixed action cost.
- Block generation when available credits are insufficient.
- Return a clear error with credits remaining and renewal date.

Possible credit costs:

- AI listing from photos: 1 credit.
- Additional marketplace rewrite: 1 credit.
- Pricing comp analysis: 1 credit.
- Bulk relist recommendations: 1 credit per batch or per item, decided before
  implementation.
- Manual edits, inventory updates, and marketplace sync should not consume AI
  credits unless they call AI.

Future billing options:

- Paid credit top-ups.
- Annual plans.
- Team seats.
- Usage-based overages.
- Enterprise custom limits.

## AI Listing Engine

The AI experience is the core product advantage. It must feel like it thinks
like a reseller, not like generic AI text generation.

Required improvements:

- Generate marketplace-specific title variants.
- Keep eBay titles at or under 80 characters.
- Generate Etsy tags and materials.
- Generate item specifics by category.
- Ask for missing measurements when needed.
- Detect brand, model, size, color, material, style, flaws, and condition.
- Generate short, honest, buyer-friendly descriptions.
- Avoid unsupported claims.
- Add confidence labels and review warnings.
- Show why a field needs review.
- Use category suggestions from marketplace APIs where available.
- Use saved seller preferences for tone, return language, shipping style, and
  description format.
- Calibrate confidence against real seller corrections.
- Track which AI fields sellers changed before publish.

AI validation goals:

- A seller should trust the AI to draft, but still review before publishing.
- Drafts should never publish automatically without explicit seller action.
- Dangerous uncertainty should block publish or require confirmation.
- Known high-risk categories should ask for measurements and condition details.

## Listing Workflow

A professional reseller workflow should be faster than marketplace-native tools.

Capture:

- Mobile-first camera input.
- Multi-photo upload.
- HEIC/JPEG/PNG/WebP support.
- Image compression before upload.
- Photo order controls.
- Main photo selection.
- Background cleanup as a future enhancement.
- Duplicate image detection.

Draft creation:

- Condition selection.
- Quantity.
- Category hint.
- Price strategy.
- Return preference.
- Marketplace targets.
- Storage location.
- Cost of goods.
- Measurements.
- Notes only visible to seller.

Review:

- Marketplace tabs.
- eBay preview.
- Etsy preview.
- Direct listing preview.
- Required field blockers.
- Warnings for low confidence.
- Editable title, description, price, quantity, category, item specifics,
  shipping profile, return policy, tags, materials, and images.
- Save draft.
- Publish selected marketplaces.
- Publish all ready marketplaces.

Bulk workflows:

- Batch photo upload.
- Batch draft generation.
- Bulk edit selected fields.
- Bulk publish ready drafts.
- Bulk delist.
- Bulk relist stale items.
- CSV import/export.

## Inventory And Sales Management

Inventory should be as important as listing generation.

Inventory features:

- SKU/custom label.
- Bin/location.
- Cost of goods.
- Purchase source.
- Purchase date.
- Quantity.
- Status: draft, listed, reserved, sold, archived.
- Marketplace listing links.
- Photos.
- Listing history.
- Sync history.
- Profit history.

Sales features:

- Sale event per marketplace.
- Sold price.
- Shipping charged.
- Shipping cost.
- Marketplace fee estimate.
- Stripe fee for direct checkout.
- Cost of goods.
- Net profit.
- Margin.
- Days to sell.
- Buyer-safe metadata.
- Fulfillment state.

Analytics:

- Revenue by month.
- Profit by month.
- Sell-through rate.
- Average days to sell.
- Best categories.
- Best marketplaces.
- Stale inventory value.
- Draft conversion rate.
- Listing volume over time.
- AI credits used per published listing.

## Direct Marketplace And Stripe Connect

SnapToList can also help sellers avoid marketplace fees by creating direct
checkout links.

Direct marketplace requirements:

- Seller connects Stripe account through Stripe Connect.
- Direct listing pages load public item data only.
- Buyer checkout uses Stripe Checkout.
- Stripe webhook verifies signature.
- Checkout completion marks listing sold.
- Direct sale writes a sale event.
- Seller payout status is visible.
- Direct listing can be shared by link.
- Direct listing can be manually marked sold.
- Direct listing inventory sync should delist or reduce quantity elsewhere.

Future direct marketplace features:

- Seller storefront.
- Seller profile page.
- Cart.
- Offers.
- Local pickup.
- Coupon codes.
- Buyer messaging.
- Email receipts and shipment updates.

## Security And Compliance

Security is a launch feature.

Requirements:

- No secrets in source control.
- No secrets in screenshots.
- No secrets in browser responses.
- No marketplace access tokens in client-readable columns.
- Supabase service role key only used server-side.
- Stripe webhook signatures always verified.
- Marketplace webhook signatures verified where supported.
- Token refresh is server-only.
- OAuth state is random, single-use, tied to user, and expires.
- RLS enabled on seller-owned tables.
- Explicit grants reviewed for Supabase public schema tables.
- Views that expose data should use safe grants or security-invoker behavior.
- Audit logs for billing changes, marketplace connections, publish attempts,
  sync actions, and destructive actions.
- Account deletion and data export process documented.
- Privacy policy, terms, and support contact available.
- eBay marketplace account deletion compliance complete.
- Etsy terms and API usage requirements reviewed before public launch.

Token storage strategy:

- v1: keep tokens server-only with strict column grants and safe views.
- Before broader launch: move marketplace tokens to encrypted storage, Supabase
  vault, application-layer encryption, or another approved secret storage
  strategy.

## Reliability And Operations

Required operational systems:

- Vercel production deployment checklist.
- Supabase migration checklist.
- Database backup strategy.
- Rollback plan.
- Error monitoring.
- Marketplace API error logging.
- Stripe webhook retry visibility.
- AI cost alerts.
- Rate limits for AI, auth-sensitive routes, checkout, and marketplace actions.
- Queue or retry table for sync actions.
- Idempotency keys for publishing and billing events.
- Admin-only setup health dashboard.
- Runbook for eBay OAuth failure.
- Runbook for Etsy OAuth failure.
- Runbook for Stripe webhook failure.
- Runbook for AI API outage.

## Reseller Onboarding And Education

The app should explain what to do next without sounding like documentation.

Onboarding checklist:

- Create account.
- Confirm email or sign in with Google.
- Choose plan.
- Connect eBay.
- Connect Etsy.
- Connect Stripe for direct checkout.
- Set shipping defaults.
- Set return preferences.
- Add storage locations.
- Create first listing draft.
- Publish first listing.

Education assets:

- First listing walkthrough.
- eBay connection guide.
- Etsy connection guide.
- Shipping profile guide.
- Listing quality checklist.
- Photo quality checklist.
- Pricing strategy guide.
- AI credits and billing guide.
- Troubleshooting marketplace connection errors.

## Professional UX Requirements

The UI should feel like an operations tool for repeat daily use.

Must-have screens:

- Dashboard command center.
- New listing flow.
- Draft list.
- Draft detail/review.
- Inventory.
- Inventory item detail.
- Marketplace connections.
- Sales.
- Sync actions.
- Billing and credits.
- Account settings.
- Setup health.
- Help/support.

Dashboard command center should show:

- Credits remaining.
- Renewal date.
- Disconnected marketplaces.
- Drafts needing review.
- Failed publish attempts.
- Failed sync actions.
- Sales needing reconciliation.
- Stale listings.
- Inventory value.
- Profit snapshot.
- Next best action.

UX principles:

- Never publish without explicit confirmation.
- Always explain blockers.
- Keep marketplace-specific complexity hidden until needed.
- Make mobile photo capture excellent.
- Show safe progress states for long actions.
- Make failed actions retryable.
- Make billing limits clear before blocking work.

## Data Model Roadmap

Likely new or expanded tables:

- `workspaces`
- `workspace_members`
- `seller_settings`
- `marketplace_connections`
- `marketplace_connection_settings`
- `inventory_items`
- `marketplace_listings`
- `listing_drafts`
- `listing_images`
- `publish_attempts`
- `sync_actions`
- `sale_events`
- `billing_customers`
- `subscription_plans`
- `subscriptions`
- `monthly_credit_grants`
- `usage_ledger`
- `feature_entitlements`
- `stripe_webhook_events`
- `app_audit_logs`

Migration rules:

- Add explicit grants for Data API access where needed.
- Enable RLS on seller/workspace-owned tables.
- Use ownership predicates based on workspace membership.
- Keep token columns unavailable to browser roles.
- Keep safe read views separate from token storage.
- Add tests that fail if token columns are granted to browser roles.

## Implementation Phases

### Phase 0: Roadmap And Stabilization

- Create this roadmap.
- Keep existing eBay, Google auth, and setup-health docs linked.
- Confirm no secrets are documented.
- Decide exact plan names and credit amounts before billing implementation.

### Phase 1: Auth, eBay, And First Paid Workflow

- Fix Google sign-in if still failing.
- Add forgot password and reset password.
- Complete eBay readiness method.
- Polish draft review and eBay publish blockers.
- Add billing plan tables.
- Add Stripe subscription checkout.
- Add Stripe billing webhooks.
- Add monthly credit grants.
- Add credit gating to AI generation.

### Phase 2: Etsy And Multi-Channel Inventory

- Complete Etsy approval and OAuth.
- Implement Etsy draft listing creation.
- Implement Etsy image upload.
- Implement Etsy activation after confirmation.
- Store Etsy marketplace listings.
- Make inventory the source of truth.
- Implement sold-item sync and delist actions.

### Phase 3: Shopify-Style Channel Hub

- Redesign marketplace settings into a channel hub.
- Support multiple accounts per marketplace.
- Add Shopify connector.
- Add import/export between SnapToList and Shopify.
- Add connector health dashboard.
- Add retry queues and sync logs.

### Phase 4: Reseller Growth Tools

- Bulk listing.
- Bulk delist/relist.
- Stale inventory suggestions.
- Profit analytics.
- Seller templates.
- AI correction learning.
- Pricing comps.
- Team/workspace support.
- Support docs and public pricing page.

## Acceptance Checklist

This roadmap is complete when it covers:

- eBay launch readiness and verification.
- Etsy approval, OAuth, publish, sync, and blockers.
- Google sign-in path.
- Forgot password and reset password path.
- Shopify-style multiple marketplace connections.
- Multi-account marketplace architecture.
- Inventory as source of truth.
- Stripe subscriptions.
- Monthly AI credits.
- Zero-credit behavior.
- Stripe webhook handling.
- Professional reseller workflows.
- Security and compliance.
- Reliability and monitoring.
- Launch gates.
- Product success metrics.

