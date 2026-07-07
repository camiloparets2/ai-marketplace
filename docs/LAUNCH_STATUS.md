# LAUNCH_STATUS — living punch list

> Updated continuously during the launch-readiness run. Next session: resume
> from the first unchecked item in the highest-priority section.
> Design doc: `docs/design/launch.md`.

**Last updated:** 2026-07-07 · Phase 0 complete (audit + docs)

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
- [ ] **P0-1** `lib/ai/vision.ts`: single Vision entry point returning title, brand, model, category, condition grade, defects[], confidence 0–1 (route refactored onto it) — *Phase 1*
- [ ] **P0-2** Persist identified item to `inventory_items` (status `draft`) at intake, incl. cost-basis field — *Phase 1*
- [ ] **P0-3** Pricing engine: floor = cost_basis + fees + shipping + min_margin; strategy per item; write price + rationale to new `price_history` table — *Phase 1*
- [ ] **P0-4** eBay payload build + publish against Sandbox/dry-run (`PIPELINE_LIVE_PUBLISH` default off); save listing id to `marketplace_listings` status live — *Phase 1*
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
- (Phase 0) `chore/launch-audit` — this audit + design doc
