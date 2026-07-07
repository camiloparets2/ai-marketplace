# LAUNCH_STATUS — living punch list

> Updated continuously during the launch-readiness run. Next session: resume
> from the first unchecked item in the highest-priority section.
> Design doc: `docs/design/launch.md`.

**Last updated:** 2026-07-07 · **Phases 0–5 complete** — all P0/P1 pipeline work built and tested; PRs #6–#11 await merge (stacked, merge in order)

## Pipeline stage status

| Stage | Status | What exists | What's left |
|---|---|---|---|
| Capture | 🟢 | validation, auth, credits, rate limit | photo quality bar (P0-5), multi-photo (P2) |
| Identify | 🟡 | Claude Vision tool_use, per-field confidence | `lib/ai/vision.ts` wrapper w/ confidence 0–1 + defects (P0-1); persist at intake (P0-2) |
| Price | 🔴 | nothing (user types price) | floor engine + `price_history` (P0-3); comps + cost-basis intake (P1) |
| List | 🟡 | full eBay/Etsy/Shopify publishers, tested | dry-run mode (P0-4); guardrails + review status (P0-5); routing table (P1) |
| Sync/Delist | 🟡 | polling sync, idempotent markItemSold, cross-channel ends | `sold_events` queue + webhook intake (P0-6); atomic transition + race handling (P0-7); `pipeline_audit` (P0-8) |

## Gap list (work top to bottom)

### P0 — launch blockers
- [x] **P0-1** `lib/ai/vision.ts` Vision entry point (defects[], min-of-critical-fields confidence 0–1); /api/analyze refactored onto it; 8 tests — *Phase 1 ✅*
- [x] **P0-2** `createDraftItem` persists at intake (defects, id_confidence, cost basis; `price` now nullable; `review` status added). Migration `20260707100000_pipeline_intake.sql` — **repo only, NOT yet applied to the live DB** — *Phase 1 ✅*
- [x] **P0-3** `lib/pricing.ts`: floor = cost+fees+shipping+max($3,15%); strategies user_target/floor_markup; `price_history` rows w/ rationale + inputs; 8 tests — *Phase 1 ✅*
- [x] **P0-4** `lib/pipeline.ts` + `POST /api/pipeline`: identify → draft → price → publish. Sandbox real, production **dry-run unless `PIPELINE_LIVE_PUBLISH=true`** (ships off). Pure eBay payload builders extracted + tested; 7 pipeline tests — *Phase 1 ✅*
- [x] **P0-5** `lib/guardrails.ts`: 6 gates (confidence ≥0.80, price ≥ floor, sane range $5–$2k, prohibited-item regexes, VeRO brand watch list, photo quality bar) → any-fail parks the item `status=review` with `review_reasons`; migration `20260707200000_review_reasons.sql` (repo only); 13 gate tests + 3 pipeline-routing tests — *Phase 2 ✅*
- [x] **P0-6** `sold_events` queue (dedupe on platform+order+listing, NULLS NOT DISTINCT) + `POST /api/webhooks/ebay-orders` intake (challenge GET, tolerant parse, listing-based seller attribution) + polling backstop enqueues instead of direct-marking. Migration `20260707300000_sold_events_audit.sql` (repo only) — *Phase 3 ✅*
- [x] **P0-7** `claim_item_sale` SQL fn: single guarded UPDATE (row lock serializes; `quantity > 0` makes overselling impossible); qty decrement; delist-everywhere at 0 via `endOtherListings`; race loser → `oversellAction` **stub** (cancel/refund API call is a follow-up) + `oos_cancel` audit; race test in `lib/sold-events.test.ts` — *Phase 3 ✅*
- [x] **P0-8** `pipeline_audit`: auto_publish, auto_delist (in endListings), sold_event, oos_cancel, review_hold all write rows — *Phase 3 ✅*

### P1
- [x] **P1-1** `lib/routing.ts`: eBay always; Etsy ONLY handmade / vintage ≥20yr / craft supply (Vision now emits `handmade`/`estimatedYearMade`/`craftSupply`); pipeline enforces it — the Etsy leg also only fires in live mode since Etsy has no sandbox; 7 routing + 4 enforcement tests — *Phase 4 ✅*
- [x] **P1-2** Review queue: held items show their failing gates on /inventory with **Approve & post** (releases + publishes via the same safe publish step, optional price override recorded in price_history) and **Reject** (archives); `review_approve`/`review_reject` audit rows; 3 tests — *Phase 4 ✅*
- [x] **P1-3** `lib/comps.ts`: Marketplace Insights sold comps (403 = limited release → graceful degrade) + Browse active-listing context; `decidePrice` gains a `comps` strategy (median clamped to floor) and ignores sparse comps (<3 sold) with a lower-confidence note; 9 tests — *Phase 4 ✅*
- [x] **P1-4** Cost basis: manual entry at intake (`costBasis` on /api/pipeline; `set_cost` action after) + assumed-cost fallback (30% ⚑ of comp median) when absent — *Phase 4 ✅*
- [x] **P1-5** QA pass (Chromium, phone 390px + desktop 1280px, 12 routes): zero page errors, zero horizontal overflow, auth gating verified end-to-end, API contract sweep (401/400/challenge-hash/ACK paths all correct). One bug found & fixed: `/` and `/login` had **no h1** (bare wordmark spans) → wrapped in `<h1>` (visually inert), regression-locked in `tests/regression/page-headings.test.ts`. Gate: `tsc --noEmit` ✓ · **162/162 tests** ✓ · lint ✓ · production build ✓ — *Phase 5 ✅*

### P2 — stretch
- [ ] Second flip channel scaffold behind the routing table
- [ ] Audit-log viewer
- [ ] Pipeline observability (structured logs/metrics)
- [ ] Multi-photo listings

## Decisions awaiting Camilo ⚑
See the defaults table in `docs/design/launch.md` — confidence 0.80, min_margin max($3, 15%), sane range $5–$2,000, 30% assumed-cost fallback, eBay fee 13.6%+$0.40, second channel deferred.

## Camilo's manual gates (unchanged from prior sessions)
- Set the 7 Vercel eBay env vars (see `.env.local.example` on PR #4) + the rest of `.env.example`
- Refresh the rotated Sandbox Cert ID if live sandbox e2e is wanted
- Merge PRs #3 (telemetry), #4 (eBay prod config), #5 (schema vocab + hardening docs), and this run's PRs
- Flip Vercel production branch to `master` and redeploy
- eBay: activate support ticket for higher call limits
- Supabase dashboard: leaked-password protection toggle
- Stripe: webhook endpoint + one test-mode subscription

## PRs opened this run
- (Phase 0) `chore/launch-audit` — audit + design doc (PR #6)
- (Phase 1) `feature/pipeline-happy-path` — vision wrapper, intake persistence, pricing engine, auto-list pipeline (PR #7, stacked on #6)
- (Phase 2) `feature/auto-post-guardrails` — guardrail gates + review routing (PR #8, stacked on #7)
- (Phase 3) `feature/sync-auto-delist` — sold_events queue, atomic claim, webhook intake, audit trail (PR #9, stacked on #8)
- (Phase 4) `feature/routing-review-pricing` — routing table, review queue, comps + cost-basis depth (PR #10, stacked on #9)
- (Phase 5) `fix/qa-launch-pass` — QA fixes + regression tests (stacked on #10)

## Deploy checklist (updated after Phase 5)
1. Merge PRs **in stack order**: #6 → #7 → #8 → #9 → #10 → #11 (plus standalone #3 telemetry, #4 eBay prod config, #5 schema-vocab docs).
2. Apply the three new migrations to production Supabase (in timestamp order): `20260707100000_pipeline_intake`, `20260707200000_review_reasons`, `20260707300000_sold_events_audit`.
3. Vercel env: everything in `.env.example` **plus new** `PIPELINE_LIVE_PUBLISH` (leave `false`!), `EBAY_ORDER_WEBHOOK_VERIFICATION_TOKEN`, `EBAY_ORDER_WEBHOOK_ENDPOINT`.
4. Flip Vercel Production Branch → `master`, redeploy.
5. Supervised sandbox run: `EBAY_ENV=sandbox` + a sandbox seller connection → POST /api/pipeline with a real photo → confirm sandbox listing + inventory rows + price_history + audit rows.
6. Register the order-notification endpoint in the eBay dev portal (challenge will pass once env is set).
7. Only after 5–6 look right: consider `PIPELINE_LIVE_PUBLISH=true`.
8. Note: Next 16 warns `middleware.ts` → `proxy.ts` rename is coming; harmless today, track for a future chore PR.

## New migrations awaiting live apply
- `20260707100000_pipeline_intake.sql` (price nullable, defects/id_confidence, review status, price_history)
- `20260707200000_review_reasons.sql` (review_reasons on inventory_items)
- `20260707300000_sold_events_audit.sql` (sold_events, pipeline_audit, claim_item_sale fn)

## Known follow-ups (deliberate stubs)
- Oversell loser path logs + audits but does NOT yet call the platform cancel/refund API — operator acts on the `oos_cancel` audit row until wired.
- eBay Notification API payloads are parsed tolerantly but signature verification of the webhook body is not yet implemented (endpoint is unguessable + challenge-verified; polling backstop covers gaps). Add signature checks before scale.
- Direct (Stripe) sales still use the legacy `markItemSold` path — safe (idempotent) but bypasses the queue; migrate for uniform audit.
