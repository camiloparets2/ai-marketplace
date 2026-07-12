# Comps-grounded pricing + brand-hallucination guard

Status: implementing · Owner: Camilo · 2026-07-12

## Problem

The AI suggests a price with no market grounding — it produced $6.50 on a
50 lb bag of concrete. The shipping-floor fixes (#23/#24-era, now in the
#25–#30 stack) stop the *loss*; this work stops the *guess*: anchor every
suggested price to real eBay market data, and when no trustworthy data
exists, say so, lower confidence, and route to review instead of publishing
an ungrounded number.

## Hard constraints honored

- **Official eBay APIs only** — Marketplace Insights (sold comps) and Browse
  (active listings). No scraping, no browser automation, no cookies, no
  stack change, Claude Vision stays.
- Additive to the existing engine: `decidePrice` is EXTENDED (it already has
  a comps strategy and the null-floor money rules); nothing is duplicated.
- **Base-branch dependency ⚑**: the brief says "base on master after #23/#24
  are merged". #23/#24 were CLOSED as superseded — their content lives in
  the open stack #25→#30 (see `docs/LAUNCH_HARDENING.md`). Bare master lacks
  the shipping-floor fixes this brief requires intact, so this branch is cut
  from the stack tip (`codex/lh-final-report`) and its PR stacks on #30.
  **Merge #25→#30 first.**

## Part 1 — the comps engine

### Module layout (extend, don't duplicate)

- `lib/comps.ts` keeps the pure, client-safe pieces (median, payload
  extraction, summary building) and the `CompsSummary` type — now ENRICHED:

  ```ts
  interface CompsSummary {
    // unified anchor: sold median when sold data exists, else active median
    medianPrice: number | null;
    lowPrice: number | null;     // 25th percentile of the source prices
    highPrice: number | null;    // 75th percentile of the source prices
    sampleSize: number;          // count of the source prices
    demandSignal: "high" | "medium" | "low";
    source: "sold" | "active";
    // legacy fields preserved for existing consumers:
    medianSoldPrice; soldCount; activeCount; medianActivePrice; confidence;
  }
  ```

- `lib/platforms/ebay-comps.ts` (new) owns the network layer:
  `fetchEbayCompsFor({ accessToken, brand, categoryId, titleKeywords,
  condition, marketplaceId })` → `CompsSummary | null`.

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Price band | 25th–75th percentile, not min/max | robust to the one $1 parts-only listing and the one $999 fantasy ask |
| Anchor | median of the SOLD prices; active median only when no sold data | sold = what buyers actually paid |
| Sold source preferred | Marketplace Insights `item_sales/search` | true sold comps |
| MI not granted | Detected at runtime (401/403 → remembered for 1h, no hammering); **fall back to Browse** `item_summary/search` with `source:"active"` — never fail the flow | limited-release API |
| demandSignal | sold source: ≥10 sales → high, ≥3 → medium, else low. active source: **always "low"** | active listings measure supply/competition, not demand; pretending otherwise is the $6.50-concrete mistake in a new hat ⚑ |
| Query shape | `q = [brand, titleKeywords]`, `category_ids = leaf` when known, Browse `filter=conditions:{NEW\|USED}` mapped from our condition enum | tighter comps than free-text title search |
| Cache | `lru-cache` (already a dep), key `marketplace|brand|leaf|condition|keywords`, TTL 10 min, max 500 | rate-limit respect; comps don't move minute-to-minute |
| Trusted anchor ⚑ | sold ≥ 3 (existing MIN_SOLD_COMPS), OR active ≥ 5 when MI is unavailable | with only Browse access the alternative is "everything is ungrounded → everything to review", which makes the app unusable until eBay grants MI. Active-anchored prices carry demand:"low" + a caution note. |

### ➜ ACTION FOR CAMILO: apply for Marketplace Insights access

True SOLD comps need eBay's **Buy — Marketplace Insights API** (limited
release). Apply in the eBay developer portal: **Application Growth Check /
"Apply for production access" → Buy APIs → Marketplace Insights**
(developer.ebay.com → your keyset → API access requests). Until granted,
every price is banded from ACTIVE listings only and labeled `source:
"active"` in the UI, price_history, and this module's status. The code
detects the grant automatically the first time `item_sales/search` returns
non-403 — no deploy needed after approval.

### decidePrice wiring (lib/pricing-core.ts — extended)

1. **Trusted comps** → price anchors to `medianPrice`, adjusted:
   - condition factor ⚑ (comps rarely match condition exactly):
     New 1.05 · Like New 1.00 · Very Good 0.95 · Good 0.88 · Acceptable 0.78
   - defects: −3% per visible defect, capped at −15% ⚑
   - completeness: +5% when box/accessories detected (specs contain
     "Complete"/"In Box") ⚑ — conservative, only when explicit
   - **clamped to the floor, always** — every #23/#24 money rule is intact
     (null shipping → null floor → review; never below floor).
2. **Sparse/no comps** → keep the Claude Vision `suggestedPrice` (clamped to
   floor) as the seed, strategy `ai_estimate`, LOWER confidence, and the new
   `price_ungrounded` guardrail routes the item to REVIEW (mirror of the
   assumedCost ⚑ pattern). **An ungrounded price never auto-publishes.**
3. `PriceDecision.inputs` (persisted to `price_history.inputs` jsonb) gains
   the full comps snapshot: median/low/high/sampleSize/source/demand +
   `compsFetchedAt` ISO timestamp. No schema migration needed — `inputs` is
   already jsonb and already audited.

### Seller UI

`PricingPanel` (snap flow + /inventory/[id] edit view) shows, under the
editable price: `Similar items: $LOW–$HIGH (N sold · demand: high)` or
`(N active listings — sold data pending eBay approval)`, plus the one-line
rationale it already renders. `/api/comps` passes brand/condition/leaf
through to the new engine when the caller has them.

## Part 2 — richer extraction + brand guard (bounded)

1. **Aspect-mapped fields only** (each feeds `getItemAspectsForCategory`
   requirements from the Phase-2 readiness work — Material, Color, Size,
   Style, Pattern are the highest-frequency required/recommended aspects in
   clothing/home categories): `material`, `colorPrimary`, `colorSecondary`,
   `size`, `sizeSystem` (US/UK/EU), `style`, `pattern` — all nullable. They
   fold into `specs` under their aspect names, so they flow to eBay item
   specifics AND tighten comps queries with zero extra plumbing. No dead
   fields.
2. **Brand guard**: new `brandSource: "tag_or_label" | "logo" | "inferred" |
   "none"` in the schema + prompt instruction to only assert a brand that is
   READABLE. Post-processing in `lib/ai/vision.ts` (pure, tested):
   `brandSource === "inferred"|"none"` OR brand confidence < 80 →
   `brand = "Unbranded"`, brand confidence floored at 40 (drags overall
   confidence toward review). A compact known-brands list cross-check
   catches hallucinated brands ONLY for non-tag sources — a niche-but-real
   brand read off a tag is never overwritten.
3. **Capture nudge**: the multi-photo UI hints "front · back · brand
   tag/label close-up" — more readable tags, fewer Unbranded downgrades.
   Low-confidence extractions keep routing to review (existing gate).

## Tests

- Percentile band + demand + source math; MI-denied → Browse fallback with
  `source:"active"`; cache hit skips the second fetch; MI grant detection.
- decidePrice: anchors to adjusted median, never below floor; sparse comps →
  `ai_estimate` + `price_ungrounded` gate → review, never auto-publish; all
  existing money-rule tests untouched and green.
- Brand guard: styling-only ("inferred") guess → "Unbranded", never an
  invented brand; tag-sourced niche brand survives; low confidence → review.

## Out of scope (explicitly)

Terapeak-style analytics, repricing over time, competitor tracking, any
non-eBay comps source, GPT-4o (we keep Claude Vision), browser automation of
any kind.
