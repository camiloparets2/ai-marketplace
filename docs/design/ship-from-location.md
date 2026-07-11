# Ship-from location — per-user, globally valid (+ restoring the AI price)

Status: implementing · Owner: Camilo · 2026-07-11

## Problem

Publishing to eBay fails for any seller whose account has no inventory location:
`"No eBay inventory location found. Set EBAY_POSTAL_CODE so one can be created."`

`EBAY_POSTAL_CODE` is a single global env var with a hardcoded `country: "US"`
(`lib/platforms/ebay.ts` → `ensureMerchantLocation`). SnapToList serves many
sellers worldwide; a ship-from address is **per-seller data**, not deploy
config. The offer payload also hardcodes `EBAY_US` / `USD`, and business-policy
lookup hardcodes `marketplace_id=EBAY_US` — wrong for any non-US seller.

Separately, the analyze flow lost its AI-suggested price (see Part 2 below).

## Part 1 — per-user ship-from location

### Flow (least friction first)

1. **Auto-detect on connect.** The eBay OAuth callback calls
   `getInventoryLocations`. If the seller already has a merchant location, its
   `merchantLocationKey` (and the location's country) is stamped into
   `platform_connections.meta` — the user is never asked anything.
2. **Ask only if needed.** No location detected and no stored ship-from → the
   callback redirects to `/settings/ship-from?connected=ebay` with a short
   form (country, postal code, city, state/province). Editable later from the
   same page, linked from `/channels`.
3. **Create automatically.** From the stored address we call
   `createInventoryLocation` (key `snap-to-list-default`, per-seller
   namespace) and persist the key in connection meta. Publish always runs
   `ensureMerchantLocation` (meta key → detect → create) before creating the
   offer, so the flow self-heals for accounts connected before this change.

### Global correctness

- `country` — ISO 3166-1 alpha-2, required, validated against the full ISO set.
- `postal_code` — required only where the country uses postal codes (a curated
  `NO_POSTAL_CODE_COUNTRIES` set exempts countries without one). Format is NOT
  validated per-country (no 5-digit US assumption) — trim + sane charset only;
  eBay is the final validator and its error is surfaced.
- `city` / `state_or_province` — required when the country has no postal codes
  (eBay needs `country+postalCode` **or** `country+city+stateOrProvince`);
  optional otherwise.
- Marketplace + currency (+ category tree id + Content-Language) are derived
  from the seller's country via `lib/platforms/ebay-marketplaces.ts`
  (EBAY_US/GB/DE/AU/CA/FR/IT/ES/…), stored per connection in `meta`, and used
  for the offer payload, policy lookup, and category suggestions. Countries
  without their own eBay marketplace fall back to EBAY_US/USD (how eBay treats
  such sellers today). Detection order: connection meta → detected location
  country → ship-from country → EBAY_US.

### Schema

No existing profile/settings table exists (checked all migrations:
billing/inventory/sync/rate-limit tables only), so one new table:

```sql
create table public.seller_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ship_from_country char(2) not null,
  ship_from_postal_code text,
  ship_from_city text,
  ship_from_state_or_province text,
  created_at / updated_at timestamptz
);
-- RLS on, no policies, browser grants revoked (house pattern) —
-- all access via API routes holding the service role.
```

`merchantLocationKey`, `marketplaceId`, `currency` live in
`platform_connections.meta` (jsonb) — same pattern as Etsy `shopId` / Shopify
`shop`. No connection-table migration needed.

### Error UX

`ensureMerchantLocation` with nothing to go on throws a typed
`EbayShipFromMissingError`. `/api/publish` maps it to an error result carrying
`actionUrl: "/settings/ship-from"` + `actionLabel`, and the result card renders
**"Add your ship-from location to publish →"** linking to the form. No env-var
text ever reaches an end user. `EBAY_POSTAL_CODE` remains only as a
deprecated local-dev fallback (still US-only, logged as deprecated).

## Part 2 — restore the editable AI-suggested price

**Root cause (verified, not the guardrails):** commit `e548dab` ("route all
Vision calls through lib/ai/vision.ts"), an ancestor of the launch stack
(PR #19) and of `codex/launch-hardening` (PR #20), rewrote
`lib/types/extraction.ts` and dropped `suggestedPrice` + `priceRationale` from
the interface AND the tool schema. The Vision model is never asked for a
price; `/api/analyze` can't return one; `app/page.tsx` initialises
`price = ""` and nothing fills it. `priceFloorGate` / `computeFloor` never see
a suggestion at all (they only run in the auto-post pipeline, which prices via
`decidePrice` and already always yields a price). Nothing was ever persisted
to a `suggested_price` column — the old flow returned it to the client only.

**Fix:**

- Re-add `suggestedPrice: number | null` + `priceRationale: string | null` to
  `ExtractionResult` and the extraction tool schema; prompt instructs the
  model to always propose a realistic resale price with a one-line rationale.
- `app/page.tsx` pre-fills the editable price field from `suggestedPrice` and
  shows the rationale; the field stays fully editable either way.
- No cost basis → the floor note flags that the true floor can't be computed
  (assumes $0 cost) instead of silently pretending. The below-floor warning
  remains a warning: manual publish is never blocked, auto-publish is still
  gated by `priceFloorGate` (item parks in review — unchanged).
- Pipeline pricing (`decidePrice`) is intentionally unchanged; feeding
  `suggestedPrice` into the auto-pricing engine is flagged as a follow-up
  decision, not snuck in.

## Tests

- Ship-from validation: US/GB/DE/AU accepted (incl. non-numeric formats like
  `SW1A 1AA`), postal-free country requires city+state, bad country rejected.
- Marketplace derivation per country + fallback.
- `ensureMerchantLocation`: meta short-circuit, detect→persist, create-from-
  profile (non-US payload), typed error when nothing available, env fallback.
- Vision: suggestedPrice/priceRationale passthrough + null-normalisation.
- Existing eBay payload tests updated for marketplace-aware offers.
