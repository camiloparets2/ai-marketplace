# LAUNCH_STATUS — living punch list

> Updated continuously during the launch-readiness run. Next session: resume
> from the first unchecked item in the highest-priority section.
> Design doc: `docs/design/launch.md`.

**Last updated:** 2026-07-07 · Phase 1 complete (happy path, PR pending merge)

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
- [ ] **P0-5** Auto-post guardrails (confidence ≥0.80, price ≥ floor + sane range, prohibited-item check, VeRO flag, photo quality bar) → all-pass publishes, any-fail → `status=review`; tests per gate — *Phase 2*
- [ ] **P0-6** eBay order event intake normalized into new `sold_events` queue (polling backstop feeds it too) — *Phase 3*
- [ ] **P0-7** Atomic DB-locked sold transition, qty decrement, delist-all at 0, double-sale race: first committed wins, loser → out-of-stock cancel/refund stub; race test — *Phase 3*
- [ ] **P0-8** `pipeline_audit` row for every auto-publish and auto-delist — *Phase 3*

### P1
- [ ] **P1-1** Routing table: eBay default; Etsy ONLY handmade / vintage ≥20yr / craft supply; never otherwise — *Phase 4*
- [ ] **P1-2** Review queue endpoint + minimal view (approve → publish, reject → archive) — *Phase 4*
- [ ] **P1-3** Pricing comps via eBay Marketplace Insights w/ conservative fallback + lowered confidence when sparse (Insights is limited-release — fallback is default) — *Phase 4*
- [ ] **P1-4** Cost-basis capture at intake: manual entry + default-markup fallback — *Phase 4*
- [ ] **P1-5** /qa pass across capture → list → review; atomic fixes + regression tests; tsc/tests/lint/build clean — *Phase 5*

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
- (Phase 1) `feature/pipeline-happy-path` — vision wrapper, intake persistence, pricing engine, auto-list pipeline (stacked on #6)

## New migrations awaiting live apply
- `20260707100000_pipeline_intake.sql` (price nullable, defects/id_confidence, review status, price_history)
