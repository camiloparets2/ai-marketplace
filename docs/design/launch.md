# Design Doc — SnapToList launch pipeline (Capture → Identify → Price → List → Sync/Delist)

**Status:** Living document for the launch-readiness run · started 2026-07-07
**Companion punch list:** [`../LAUNCH_STATUS.md`](../LAUNCH_STATUS.md)
**Prior art:** `docs/launch-roadmap.md` (strategy), `docs/design/data-model-tokens.md` (token store ADR), `docs/design/supabase-hardening.md`

## Problem

A reseller photographs an item. The system must identify it, price it
defensibly, list it on the right marketplace automatically when it is safe to
do so (route to human review when it is not), and — the core promise — never
oversell: the moment it sells anywhere, it comes down everywhere else.

## Pipeline stages — audit (2026-07-07)

### 1. Capture — ✅ mostly done
- Client pre-processing (HEIC→JPEG, resize ≤2048px, re-encode) + server byte
  re-validation (`lib/image-validation.ts`), auth gate, per-user rate limit,
  atomic credit spend/refund. All in `app/api/analyze/route.ts`.
- **Gap (P0):** no photo quality bar (blur/darkness/size floor) feeding the
  auto-post decision. **Gap (P2):** single photo per listing.

### 2. Identify — 🟡 works, wrong shape
- Claude Vision via forced tool_use returns `ExtractionResult`
  (`lib/types/extraction.ts`): title/brand/model/UPC/condition/category/specs
  + per-field confidence 0–100.
- **Gap (P0):** the call lives inline in the route — CLAUDE.md mandates
  `lib/ai/vision.ts` and it does not exist. The wrapper must expose the
  launch contract: title, brand, model, category, **condition grade,
  defects[], overall confidence 0–1**.
- **Gap (P0):** nothing persists at identify time. The item should exist in
  the DB (status `draft`) the moment identification succeeds, so pricing,
  guardrails, and the review queue have a row to hang state on.

### 3. Price — 🔴 missing entirely
- Today the user types a price in the review UI; there is no engine.
- **Build (P0):** pricing engine computing a **floor**
  (`cost_basis + marketplace fees + shipping + min_margin`) and choosing a
  per-item strategy; every decision writes price + rationale to
  **`price_history`** (new table).
- **Build (P1):** comps from eBay Marketplace Insights (sold + active
  counts/prices) with graceful fallback to conservative pricing + lower
  confidence when comps are sparse. NOTE: Marketplace Insights is a
  limited-release API — fallback is the default until access is granted.
- **Build (P1):** cost-basis capture at intake (manual entry field +
  default-markup fallback when absent).

### 4. List — 🟡 strong publisher, zero guardrails
- Full eBay Sell Inventory chain works and is unit/integration-tested:
  merchant location → taxonomy suggest → inventory item (aspects from
  brand/model/specs) → seller policies → offer → publish
  (`lib/platforms/ebay.ts`). Sandbox selectable via `EBAY_ENV`. Etsy,
  Shopify, assisted FB/OfferUp, and Stripe direct also work.
- **Gap (P0):** no dry-run mode and no auto-post decision. Everything the
  user selects publishes immediately. Needs the guardrail gate (below) and a
  `status=review` path.
- **Gap (P1):** no routing table — the user picks targets manually and Etsy
  is offered unconditionally. Launch rule: **eBay is the default channel;
  Etsy only when the item is genuinely handmade, vintage 20+ years, or a
  craft supply; never otherwise.**

### 5. Sync / Delist — 🟡 polling works; webhook queue + atomicity missing
- Polling sync exists and is tested: daily Vercel cron + opportunistic +
  manual → `fetchEbaySales`/Etsy/Shopify → `matchSales` → `markItemSold`
  (idempotent) → `planEndListings` ends every other channel with per-listing
  `end_failed` retry state (`lib/order-sync.ts`, `lib/inventory.ts`).
- **Gap (P0):** no event intake. Build an eBay order **webhook/notification
  endpoint** normalizing into a single **`sold_events`** queue (new table);
  polling stays as the backstop and also feeds the queue.
- **Gap (P0):** the sold transition is read-then-write, not DB-locked; two
  near-simultaneous sales of the same item race. Needs an **atomic guarded
  transition** (single conditional UPDATE, first committed wins), quantity
  decrement, delist-everywhere at qty 0, and an out-of-stock cancel/refund
  stub for the loser.
- **Gap (P0):** no audit trail. Every auto-publish and auto-delist writes a
  **`pipeline_audit`** row (new table).

## Auto-post guardrails (P0 — Phase 2)

Publish automatically **only when ALL pass**; otherwise the item lands in
`status=review` with the failing gates recorded:

1. identification confidence ≥ **0.80** ⚑
2. price ≥ floor AND within a sane absolute range
3. prohibited/restricted-item keyword check
4. brand-gating / VeRO-list flag
5. ≥ 1 photo passing the basic quality bar

## Schema vocabulary (design flag — resolved per the data-model ADR)

The launch brief says `items` / `listings`; this repo's canonical, live,
RLS-locked tables are **`inventory_items`** / **`marketplace_listings`**
(see `docs/design/data-model-tokens.md`: vocabulary moves to the table, not
the other way). The brief's genuinely new concepts become **new** tables:
`price_history`, `sold_events`, `pipeline_audit`. No renames.

## Safety rails for this run

- **No real production eBay listings.** The pipeline's publish step runs
  against Sandbox or in dry-run; tests mock the API.
- New env flag `PIPELINE_LIVE_PUBLISH` (default **off**) gates any
  production auto-publish; the existing *user-initiated* publish flow is
  unchanged. `EBAY_ENV=sandbox` for any live-ish exercise.

## Defaults awaiting Camilo's confirmation ⚑

| Decision | Default used | Where |
|---|---|---|
| Auto-post confidence threshold | **0.80** | guardrails |
| `min_margin` | **max($3 flat, 15%)** of price | pricing floor |
| Sane price range | **$5–$2,000** auto; outside → review | guardrails |
| Default markup when cost basis absent | cost assumed **30% of comp/target price** (conservative floor) | pricing |
| Second flip channel | **deferred** (routing table has the slot) | routing |
| eBay fee estimate in floor | **13.6%** final value fee + $0.40 | pricing |

## Success criteria

- Photo → identified → priced (with rationale row) → sandbox/dry-run
  published → `marketplace_listings` row `status=live`, all under test.
- A failing gate provably routes to review instead of posting (tests).
- Two simultaneous sold events: exactly one wins; the other triggers the
  out-of-stock path; audit rows for both (race test).
- `tsc --noEmit`, full suite, lint, production build all clean.
