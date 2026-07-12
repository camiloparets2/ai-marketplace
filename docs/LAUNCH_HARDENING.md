# LAUNCH_HARDENING — living punch list (authoritative status file)

> The single source of truth for the US-only eBay private-beta hardening run.
> Supersedes `TODOS.md`, `docs/LAUNCH_STATUS.md`, and `docs/launch-roadmap.md`
> (all removed 2026-07-12; recoverable in git history). Next session: resume
> at the first unchecked item of the lowest-numbered phase.

**Last updated:** 2026-07-12 (Phase 0 in progress)
**Branch under review:** `codex/ebay-beta-launch` (consolidation base — every
phase lands as a small stacked PR on top of it; **nothing merges without
Camilo's review**).

## Ground truth (do not re-litigate)

- `master` is canonical. PR #19 (launch stack) and PR #21 (per-user ship-from
  + restored AI price) are MERGED and LIVE at https://snaptolist.vercel.app.
- Vercel Branch Tracking fixed (`main` → `master`); production deployment
  blocker RESOLVED. Supabase `seller_profiles` collision repaired in prod.
- `PIPELINE_LIVE_PUBLISH` stays **false** for this entire run; no real
  production eBay listing may be created by automation. (User-initiated
  Publish/Approve intentionally bypasses the flag — that is a human act.)
- The Supabase project is SHARED with an unrelated OSHA app (`inspections`,
  `inspection_types`, `corrective_actions`, plus `la_patrona` prototype-era
  tables). NEVER touch those tables. See Phase 5 isolation note.

## Production dependency audit (master, 2026-07-12)

`npm audit --omit=dev`: **3 vulnerabilities — 1 high, 2 moderate.**

| Package | Severity | Advisory summary | Fix |
|---|---|---|---|
| `next` (< 16.2.10) | **high** | middleware/proxy bypass ×4, cache poisoning ×3, XSS ×2, DoS ×3, SSRF | upgrade to ≥ 16.2.10 (Phase 5) |
| `@anthropic-ai/sdk` 0.79–0.91 | moderate | insecure default file perms (memory tool — unused here) | upgrade to ≥ 0.111.0 (Phase 5) |
| `postcss` < 8.5.10 (transitive of next) | moderate | XSS via unescaped `</style>` | resolved by the next upgrade |

## Phase status

### Phase 0 — Consolidate + honest audit — ✅ DONE (this PR)
- [x] Dirty/prototype-tree credential scan: the working container held a
      CLEAN tree (all prior work committed & pushed on
      `fix/draft-publish-and-credits`); no dirty tree existed to back up.
      Prototype code lives only in git history (`5b123ce` and earlier) and on
      old remote branches — nothing to preserve locally.
- [x] `codex/ebay-beta-launch` branched from `origin/master`; PR #22
      (migration repair), PR #23 (seller readiness + money-bug fixes), and
      PR #24 (draft publish/retry + credits + image preflight) merged in, in
      order. Gate green after each (tsc, 266 tests, lint).
- [x] PR #20 valid fixes: the two migrations **already applied to production**
      (service-role Data API grants; launch FK indexes) + the
      status-check idempotency repair + `.nvmrc` Node 24 pin ported now.
      The rest of #20 is ported per-phase (mapping below) — its base predates
      ship-from, so wholesale cherry-picks are unsafe.
- [x] Prototype salvage audit: mobile/PWA (`app/manifest.ts`), image
      validation (`lib/image-validation.ts`), analytics (`lib/telemetry.ts`)
      are ALREADY on master via #19. Remaining prototype ideas (dual-image
      stock-photo pairing `7a6cce8`/`d8edb94`, prompt-injection defense
      `e9814db`) recorded here — note: stock-photo fallback for used items is
      **prohibited** by Phase 2 (picture policy/IP risk), do not salvage it.
- [x] `npm audit --production` on master: table above (3 real findings).
- [x] Stale `TODOS.md` / `docs/LAUNCH_STATUS.md` / `docs/launch-roadmap.md`
      replaced by this file.
- [x] Superseded stacked PRs closed after replacement: #7, #8, #10, #11,
      #13–#16 (superseded by merged #19); #22, #23, #24 (folded into this
      branch); #20 (ported manually per-phase).

**PR #20 → phase mapping (port manually, verify each against current master):**
| #20 piece | Lands in |
|---|---|
| beta-key removal, session-required guard, fail-closed credits/rate limit | Phase 1.4 |
| inventory-before-publish + reconciliation surfacing | Phase 1.3 |
| real account-deletion erasure + deletion route hardening | Phase 1.6 |
| eBay immutable user ID capture at OAuth (+ tests) | Phase 2 |
| honest landing/help/SEO copy | Phase 4 |
| dep upgrades, proxy.ts migration, engines pin | Phase 5 |
| service-role grants + FK index migrations, .nvmrc | Phase 0 ✅ |

### Phase 1 — P0 money + safety bugs — ◐ partially done via #23/#24
- [x] 1.1a Floor never coerces unknown shipping to $0 (`computeFloor` → null;
      `shipping_unknown` guardrail; manual flow blocks publish) — in #23.
- [x] 1.1b No free-shipping policy default (buyer-paid + per-offer
      `shippingCostOverrides`, app-default-policy-only, refuses null
      shipping) — in #23.
- [ ] 1.1c **Policy creation requires explicit seller confirmation of the
      exact shipping/handling/return settings** — today `ensureEbayPolicies`
      auto-creates defaults at connect/publish/"Set up automatically".
      Creation must move behind a confirmation UI showing the exact terms.
- [x] 1.2 Image preflight (`assertPhotosPubliclyReachable` in
      `publishToEbay`) + bucket-visibility assertion (`lib/setup-health.ts`,
      `GET /api/health`) — in #24. Camilo flips the bucket public himself.
- [ ] 1.3 Persist BEFORE publish: create inventory item + publish_attempt
      row before any marketplace call; reconciliation state
      (`reconciliationRequired`) when eBay succeeds but recording fails.
- [ ] 1.4 Fail-closed auth/billing/rate-limit: remove `APP_INTERNAL_BETA_KEY`
      (+ public counterpart + browser `x-api-key`); Supabase session required
      on every user/AI route; 503 without calling Claude when credits or
      rate-limit backends are unavailable.
- [ ] 1.5 Webhook signature verification (X-EBAY-SIGNATURE, Event
      Notification SDK-style verification behind a tested wrapper; 1h key
      cache; 412 invalid / 400 malformed / 5xx processing) + idempotent
      notification-receipt table keyed by notification ID.
- [ ] 1.6 Account deletion actually erases (tokens, identity metadata, eBay
      listing/order identifiers, raw payloads); errors → non-2xx for retry.

### Phase 2 — eBay compliance + retry safety — ☐ not started
- [ ] `commerce.identity.readonly` scope; store immutable ebayUserId,
      username, registration marketplace at OAuth; reconnect/backfill path.
- [ ] Deterministic SKU (inventory item + marketplace), retry reuses
      inventory item/offer — no duplicate listings.
- [ ] Offer payload: listingDuration GTC, merchant location, quantity,
      marketplace currency, 3 policy IDs, category-specific condition enum.
- [ ] Leaf-category validation; never a hardcoded fallback category.
- [ ] getItemAspectsForCategory: BLOCK on missing REQUIRED aspects; surface
      required-soon/recommended. Metadata API condition policies + product
      identifier requirements.
- [ ] Images: ≤24 single-SKU, ≥500px (recommend 1600), no watermarks/text
      overlays, seller originals FIRST, REMOVE stock-photo fallback for used.
- [ ] Title optimizer (≤80 relevant chars) + description content rules.
- [ ] Keep #23 readiness detector; defaults only after explicit confirmation
      (same work item as 1.1c).
- [ ] Order polling pagination + verified notifications + 15-min backstop;
      oversell races → urgent manual alert, never auto-cancel.

### Phase 3 — Broken core loop — ✅ DONE via #24 (folded in Phase 0)
Draft publish/retry (zero AI, zero credits, regression-locked), item
detail/edit view (`/inventory/[id]`), failure reason + CTA on draft cards,
dashboard CTA lands on `?filter=draft`. Remaining delta: none known.

### Phase 4 — Honest product copy — ☐ not started
- [ ] Replace "List it everywhere in seconds" / "never oversell" with the
      honest beta promise; label Etsy/Shopify/Facebook/OfferUp/direct per
      VERIFIED state; explicit simultaneous-sale disclosure.
      (#20's copy diff is a starting point; verify each claim.)

### Phase 5 — Dependencies, infra, isolation — ☐ not started
- [ ] Upgrade/pin next ≥16.2.10, React, @anthropic-ai/sdk ≥0.111,
      Supabase, Stripe, PostHog, Vitest + transitives; Node 24 (`.nvmrc` ✅,
      `engines` pending); zero production audit findings.
- [ ] middleware.ts → proxy.ts (Next 16 convention), nested route
      protection, preserve refreshed cookies, fail closed on missing config.
- [ ] Supabase: leaked-password protection (dashboard toggle — Camilo),
      production SMTP (Camilo), keep service-role-only grants.
- [ ] ⚠ ISOLATION: document OSHA blast radius; recommend dedicated Supabase
      project pre-scale. DO NOT touch `inspections*`, `corrective_actions`,
      or `la_patrona`/legacy tables.

### Phase 6 — Test & release gates — ☐ not started
Contract tests (GTC, deterministic retry, aspects, condition policies, image
rules, policy confirmation, identity storage, signature rejection, deletion,
pagination, reconciliation), authenticated E2E list, supervised SANDBOX
scenario script, eBay portal test notifications, Stripe test-mode checklist.

### Phase 7 — Analytics + advertising readiness — ☐ not started (gated on P0s)
Funnel instrumentation, UTM persistence + opt-out, support email, spend
alerts, backups, error notifications. **No advertising until ≥30 successful
listings and ≥1 verified sale→sync→delist.**

## Needs Camilo (cannot be done from code)
- Flip `listing-photos` bucket to public (Supabase dashboard) — `GET
  /api/health` will confirm.
- Apply new migrations when merging: `20260712000000_item_shipping_cost.sql`
  (+ any added by later phases).
- Supabase dashboard: leaked-password protection toggle; production SMTP.
- eBay reconnect after Phase 2 ships (new `commerce.identity.readonly` scope).
- Decide: dedicated Supabase project for Snap to List (recommended before
  scale/advertising).
- Review + merge the stacked phase PRs in order.
