# Snap to List — ai-marketplace

Photograph an item → Claude Vision extracts a structured listing → publish it
everywhere in one tap.

## What happens per platform

| Platform | Integration | How it works |
|---|---|---|
| eBay | **Live API publish** | OAuth-connected seller account → Sell Inventory API (inventory item → offer → publish). Returns the live `ebay.com/itm/...` URL. |
| Etsy | **Live API publish** | OAuth (PKCE) connected shop → Open API v3 (draft listing → photo upload → activate). Returns the live `etsy.com/listing/...` URL. Activation incurs Etsy's $0.20 listing fee. |
| Facebook Marketplace | **Assisted post** | Facebook offers no public listing API for individual sellers. The app composes the listing, copies it to your clipboard, hands you the photo, and deep-links into `facebook.com/marketplace/create/item`. |
| OfferUp | **Assisted post** | OfferUp has no public API. Same one-tap copy + photo + deep link into `offerup.com/post`. |
| Direct link | **Stripe Payment Link** | No-fee direct checkout link you can share anywhere. |

## Pipeline

1. **Snap** — camera/file input; HEIC→JPEG conversion, resize to 2048px, JPEG 0.85 (client-side, `lib/image-validation.ts`)
2. **Extract** — `/api/analyze` → Claude Vision with a forced tool call returning `ExtractionResult` (title, brand, model, UPC, condition, category, specs, dimensions, shipping suggestion, per-field confidence)
3. **Review** — editable form with low-confidence "⚠ review" indicators
4. **Publish** — `/api/publish` fans out to the selected targets in parallel; each target succeeds or fails independently and the UI renders one status card per platform

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

## Commands

```bash
npm run dev     # Next.js dev server
npm test        # vitest (unit + regression)
npm run lint    # eslint
npm run build   # production build
```
