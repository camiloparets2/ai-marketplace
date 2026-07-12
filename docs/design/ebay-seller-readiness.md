# eBay seller readiness — business policies as onboarding, not an error

Status: implementing · Owner: Camilo · 2026-07-11

## Problem

A brand-new seller's first publish dies with a raw eBay 400:
`"eBay return_policy lookup failed (400): User is not eligible for Business Policy."`

Every offer on the Sell Inventory API must reference three Business Policies
(fulfillment / payment / return). A seller only has those when they (a) are a
registered eBay seller with payouts set up, (b) are opted into the Business
Policies program, and (c) have created at least one of each policy. Today
`resolvePolicies` assumes all three and dumps eBay's error on the user. This
hits EVERY new seller worldwide — it is onboarding, not an error.

## Approach — an ensure chain, mirroring ship-from (PR #21)

`ensureEbayPolicies(conn, marketplace)` replaces the lookup-only
`resolvePolicies` (extended in place, not duplicated): **env overrides → meta
cache → detect → remediate → cache**, so existing connections self-heal on
their next publish, exactly like `ensureEbayLocation`.

1. **Env overrides** (`EBAY_*_POLICY_ID`) still win per kind — unchanged.
2. **Meta cache**: `fulfillmentPolicyId` / `paymentPolicyId` /
   `returnPolicyId` in `platform_connections.meta` (same jsonb as
   `merchantLocationKey`) → no network at all.
3. **Detect** against the seller's derived marketplace (never hardcoded
   EBAY_US): `getOptedInPrograms` for SELLING_POLICY_MANAGEMENT, then the
   three policy list calls filtered by `marketplace_id`.
4. **Remediate what we legitimately can**:
   - Not opted in → `POST program/opt_in {SELLING_POLICY_MANAGEMENT}` — no
     user action (state b).
   - Missing a policy → create a conservative default for their marketplace —
     no user action (state c).
5. **Cache** the resolved IDs in meta; reuse on every later publish.

### The three failure states, surfaced differently

| State | Detection | Handling |
|---|---|---|
| (a) Not a registered seller | eBay 400/403 containing "not eligible for Business Policy" on program/list/opt-in calls | Typed `EbaySellerSetupError(kind: "not_registered")`. Publish result carries `actionUrl` → eBay seller registration + plain-English one-liner. **The raw 400 never reaches the user.** |
| (b) Registered, not opted in | `getOptedInPrograms` lacks SELLING_POLICY_MANAGEMENT | Opt-in requires the seller's explicit confirmation (Channels page) — publish throws `policies_unconfirmed` until then. |
| (c) Opted in, missing policies | Empty list for a kind | Defaults created ONLY after the seller confirms the exact settings (`mayCreate: true` from POST /api/channels/ebay-readiness with `confirm: true`); otherwise `policies_unconfirmed`. Detection/adoption of EXISTING policies stays automatic — reads are safe. |

Edge: right after a successful opt-in, eBay can briefly still report "not
eligible" while the program activates. That maps to
`EbaySellerSetupError(kind: "policies_pending")` — "eBay is still enabling
business policies on your account, try again in a few minutes" — retryable,
NOT the registration CTA.

### Default policies (conservative, later-editable)

Created only when missing, named "Snap to List default …", all with
`categoryTypes: ALL_EXCLUDING_MOTORS_VEHICLES`, all editable afterwards in
eBay's own Business Policies manager (we link there — we do not build a
policy editor):

- **Fulfillment**: 3-business-day handling; one DOMESTIC FLAT_RATE service
  with **buyer-paid shipping** for marketplaces with a vetted default carrier
  (US/CA/GB/AU/DE — codes live in `ebay-marketplaces.ts`). The policy itself
  carries no amount; each offer supplies the item's shipping estimate via
  `shippingCostOverrides` (priority 1 = the service's sortOrder), and publish
  REFUSES an item with no shipping estimate rather than charging the buyer
  $0.00. The override applies ONLY when the policy in use is the app-created
  default (`fulfillmentPolicyIsAppDefault`, tracked in connection meta) —
  never over a policy the seller configured or pinned via env. **Free
  shipping is never a silent default** written to a seller's account: with
  unknown-shipping items (MANUAL_ESTIMATE_NEEDED) a free-shipping default
  made the seller absorb an uncosted bill (the $6.50/50-lb-concrete money
  bug). Free shipping stays an explicit seller opt-in in eBay's policy
  manager. For marketplaces without a vetted service code the policy is
  created with handling time only and the checklist tells the seller to pick
  a shipping service on eBay (known limitation, one map entry to fix each).
  Note: the ship-from ADDRESS lives on the inventory location (PR #21), not
  on the policy — the ship-from country picks the marketplace, which picks
  the default carrier.
- **Payment**: eBay managed payments, `immediatePay: true`.
- **Return**: returns accepted, 30 days, buyer pays return shipping,
  MONEY_BACK refund. Documented in the checklist copy, not hidden.

Duplicate-name races (two publishes at once) re-list and adopt the existing
policy instead of failing.

### Where the chain runs

- **Connect time** (OAuth callback): `setupEbayOnConnect` = location ensure
  (existing) + policy ensure, best-effort — a failure logs and defers, the
  checklist shows what's left. Ship-from redirect behaviour unchanged.
- **Publish time**: `publishToEbay` calls `ensureEbayPolicies` — self-heal
  for pre-existing connections.
- **Channels page**: GET `/api/channels` is **detect-only** (never mutates
  the seller's eBay account from a page view; it also returns
  `proposedPolicies` — the human-readable exact settings). The confirmation
  button ("I approve — create these policies on my eBay account") POSTs
  `/api/channels/ebay-readiness` with `{ confirm: true }`; without that flag
  the route 400s and nothing is written. Connect-time setup only detects and
  caches existing policies — it never creates.

### Readiness checklist UI (/channels, eBay card)

Connected ✓ · Ship-from ✓/✗ (→ /settings/ship-from) · Business policies:
- ready ✓
- missing → the exact proposed settings + the explicit confirmation button (states b/c)
- not_registered → "Finish your eBay seller setup →" (external eBay link)
  with the one-line explanation (state a)
- unknown → shown as unchecked with a retry hint (probe failed; publish will
  retry the full chain anyway)

The user sees all of this BEFORE spending an AI credit. (Credits are spent at
`/api/analyze`; `/api/publish` never touches billing — verified — so a failed
publish never consumes a credit either.)

## Not-registered state is never cached

`not_registered` is always probed live: the moment the user completes eBay
registration, the next publish / checklist visit / confirmed policy setup
click remediates and flips to ready with no support intervention.

## Tests (all eBay calls mocked)

- Not opted in → opt_in called → three policies created → IDs returned and
  cached (publish path proceeds).
- Cached meta IDs → zero eBay calls.
- Opted in with existing policies → detected, cached, no creation.
- "not eligible for Business Policy" → `EbaySellerSetupError(not_registered)`;
  publish result carries the registration CTA, message contains no "400";
  no billing involvement in the publish path.
- GB / DE / AU sellers → policy bodies carry EBAY_GB/DE/AU and the
  marketplace's default shipping service; offer currency already covered by
  PR #21 payload tests.
- Default policy body builders are pure and unit-tested (same pattern as the
  payload builders).
