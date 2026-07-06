# Snap to List — ai-marketplace

Photograph an item → Claude Vision extracts a structured listing → publish it
everywhere in one tap.

## What happens per platform

| Platform | Integration | How it works |
|---|---|---|
| eBay | **Live API publish** | OAuth-connected seller account → Sell Inventory API (inventory item → offer → publish). Returns the live `ebay.com/itm/...` URL. |
| Etsy | **Live API publish** | OAuth (PKCE) connected shop → Open API v3 (draft listing → photo upload → activate). Returns the live `etsy.com/listing/...` URL. Activation incurs Etsy's $0.20 listing fee. |
| Shopify | **Live API publish** | OAuth (HMAC-verified) connected store → REST Admin API product create with the photo embedded as base64. Returns the live `{shop}/products/{handle}` URL. Sales poll via orders; sold-elsewhere moves the product to draft. |
| Facebook Marketplace | **Assisted post** | Facebook offers no public listing API for individual sellers. The app composes the listing, copies it to your clipboard, hands you the photo, and deep-links into `facebook.com/marketplace/create/item`. |
| OfferUp | **Assisted post** | OfferUp has no public API. Same one-tap copy + photo + deep link into `offerup.com/post`. |
| Direct link | **Stripe Payment Link** | No-fee direct checkout link you can share anywhere. |

## Public pages

`/welcome` (marketing landing — the ad destination; signed-out visitors to `/`
land here), `/pricing`, `/help` (support docs + troubleshooting), `/privacy`,
`/terms`, `/login`. Everything else requires sign-in.

Abuse protection: expensive routes (`/api/analyze`, `/api/publish`,
`/api/billing/checkout`) are rate-limited per user/IP via an atomic Postgres
counter (`lib/rate-limit.ts`, fail-open).

## Pipeline

1. **Sign in** — Supabase Auth: Google or email/password (`/login`), with forgot/reset password flows. Marketplace connections are per-user.
2. **Snap** — camera/file input; HEIC→JPEG conversion, resize to 2048px, JPEG 0.85 (client-side, `lib/image-validation.ts`)
3. **Extract** — `/api/analyze` → Claude Vision with a forced tool call returning `ExtractionResult` (title, brand, model, UPC, condition, category, specs, dimensions, shipping suggestion, per-field confidence)
4. **Review** — editable form with low-confidence "⚠ review" indicators
5. **Publish** — `/api/publish` fans out to the selected targets in parallel; each target succeeds or fails independently and the UI renders one status card per platform

## Auth setup

1. In Supabase → Authentication → Providers, enable **Email** and **Google**
   (create a Google Cloud OAuth client whose redirect URI is
   `https://<PROJECT_REF>.supabase.co/auth/v1/callback`).
2. Set Site URL to your deployed URL and add redirect URLs for
   `{APP_URL}/auth/callback` and `http://localhost:3000/auth/callback`.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

Routes: `/login` (sign in/up + Google), `/forgot-password`, `/reset-password`,
`/auth/callback` (code exchange; validates `?next=` against open redirects),
`/api/auth/status` (safe metadata only). Signed-out visitors to the app are
redirected to `/login` by `middleware.ts`. Without the Supabase auth env vars
the app runs in legacy beta-key mode (see `.env.example`).

## Setup

```bash
npm install
cp .env.example .env.local   # fill in keys — see comments in the file
npm run dev
```

Apply the database migration (token store) to your Supabase project:

```bash
supabase db push   # or paste supabase/migrations/*.sql into the SQL editor
```

### Marketplace credentials

- **eBay** — create a keyset at [developer.ebay.com](https://developer.ebay.com), configure an OAuth "accepted" URL pointing to `{APP_URL}/api/oauth/ebay/callback`, and set `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_POSTAL_CODE`. Start with `EBAY_ENV=SANDBOX`. The seller account needs business policies (Account → Business policies) — opted-in accounts have these by default.
- **Etsy** — request an API key at [etsy.com/developers](https://www.etsy.com/developers), set the app's redirect URI to `{APP_URL}/api/oauth/etsy/callback`, and set `ETSY_API_KEY`. The connected account must have an open Etsy shop with at least one shipping profile.

Then open the app and hit **Connect →** next to each marketplace — tokens are
stored server-side (Supabase, service-role only) and auto-refreshed.

## Inventory & anti-oversell sync

Inventory is the source of truth: every publish (signed-in) writes an
`inventory_items` record plus one `marketplace_listings` row per live channel,
and every publish attempt is audit-logged. `/inventory` shows each item, its
channels, and the sync actions:

- **Mark sold** — records the sale (price, platform, timestamp) and ends the
  listing on every *other* channel: eBay offers are withdrawn, Etsy listings
  deactivated, Stripe payment links disabled. The platform where it sold is
  skipped (it ended its own listing) — except direct links, which Stripe
  leaves active and we always disable.
- **Delist all** — ends everywhere without a sale; item returns to draft.
- **Direct sales sync automatically**: a completed payment-link checkout hits
  the Stripe webhook → item marked sold → all other channels ended. No
  seller action needed.
- **eBay/Etsy sales sync automatically too** (`lib/order-sync.ts`): orders are
  polled via eBay `getOrders` / Etsy `getShopReceipts`, matched to open
  listings, and routed through the same sold pipeline. Three triggers: a
  daily Vercel Cron (`/api/sync/orders`, gated by `CRON_SECRET`), a throttled
  post-response sync whenever inventory is loaded, and a manual "Check for
  new sales" button. Processing is idempotent, so overlapping windows and
  replays are harmless. Requires the `sell.fulfillment` / `transactions_r`
  OAuth scopes — accounts connected before these were added must reconnect.
- Failed ends are marked `end_failed` with the error and retried on the next
  sold/delist action (idempotent).

Which listings to end is pure, tested logic in `lib/inventory-rules.ts`;
execution lives in `lib/inventory.ts`. Cost-of-goods columns are in place for
profit analytics (Phase 4). eBay/Etsy *sale* detection (their side) is not
polled yet — tracked in TODOS.md.

## Subscriptions & AI credits

Stripe Billing powers monthly plans; an internal credit ledger meters AI
usage. **1 credit = 1 AI listing draft** (`/api/analyze`); editing,
publishing, and syncing are free. Credits renew with each paid invoice and
don't roll over; new users get a one-time 10-credit trial automatically.
When credits hit zero, AI drafting pauses (402 with an upgrade CTA) but
everything else stays accessible.

- Plans/prices: `lib/billing/plans.ts` (plan keys double as Stripe price
  lookup keys — products/prices are auto-created at first checkout, no
  dashboard setup)
- Pages: `/pricing` (public), `/billing` (plan, credits, Stripe Customer
  Portal)
- Routes: `/api/billing/checkout`, `/api/billing/portal`,
  `/api/billing/status`, `/api/billing/webhook`
- Accounting: atomic spend via a guarded SQL UPDATE (`spend_credits`),
  audit ledger per action, idempotent webhooks (event-id dedupe +
  unique-invoice grants), refunds on failed AI calls
- Setup: set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`, point a Stripe
  webhook at `/api/billing/webhook`, and apply the billing migration

## eBay Marketplace Account Deletion endpoint (Production keyset requirement)

eBay requires every Production keyset to expose an endpoint that (a) answers a
challenge and (b) receives account-deletion notifications so you can erase that
user's data. This project ships it at:

```
app/api/ebay/account-deletion/route.ts   →   {APP_URL}/api/ebay/account-deletion
```

**Set two env vars** (see `.env.example`), locally and in the Vercel panel:

- `EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN` — a secret you invent (32–80
  chars, `[A-Za-z0-9_-]`). Paste the **same** value into the eBay Developer
  Portal.
- `EBAY_MARKETPLACE_DELETION_ENDPOINT` — the **exact** public HTTPS URL eBay is
  configured to call. The challenge hash won't match if this differs by even one
  character.

**Deploy (Vercel):** it's a normal Next.js App Router route — `git push` and
Vercel serves it automatically. No `vercel.json` or extra config needed. (Note:
a root-level `api/*.js` file is *not* used here — Next.js on Vercel only serves
`app/api/**/route.ts`.)

**Test the GET challenge locally:**

```bash
# Terminal 1 — run with the two env vars set (endpoint must match the URL you curl)
EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN=my-secret-token-abcdefg1234567890XYZ \
EBAY_MARKETPLACE_DELETION_ENDPOINT=http://localhost:3000/api/ebay/account-deletion \
npm run dev

# Terminal 2 — eBay's GET challenge
curl "http://localhost:3000/api/ebay/account-deletion?challenge_code=test_challenge_42"
# → {"challengeResponse":"<sha256 of challengeCode + verificationToken + endpoint>"}
```

**Paste into eBay Developer Portal** (Alerts & Notifications → Marketplace
Account Deletion): the endpoint URL is your deployed
`https://<your-app>.vercel.app/api/ebay/account-deletion` and the verification
token is the value you set above.

Erasure logic lives in `lib/platforms/ebay-deletion.ts` — wire new stores of
eBay-user data into `handleEbayAccountDeletion()` as the product grows.

## Commands

```bash
npm run dev     # Next.js dev server
npm test        # vitest (unit + regression)
npm run lint    # eslint
npm run build   # production build
```
