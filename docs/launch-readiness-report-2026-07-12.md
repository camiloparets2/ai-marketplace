# Launch-readiness report — 2026-07-12 (US-only eBay private beta)

## Executive verdict

**Conditionally ready for a supervised private beta — NOT ready to advertise.**
Every verified P0 money/safety bug is fixed on the PR stack (#25→#30), with
regression tests. What stands between here and real beta traffic is: Camilo's
review + merge of the stack, five dashboard/env actions only Camilo can do,
one eBay reconnect, and a supervised sandbox run of the full seller journey.
Advertising stays gated on ≥30 successful listings and ≥1 verified
sale→sync→delist (Phase 7, untouched by design).

## Fixes completed (all with regression/contract tests)

**Money (P0):**
- Unknown shipping is never priced as $0 (`computeFloor` → null; `shipping_unknown` gate; manual + draft publish both blocked without a cost). Evidence: the live $6.50/50-lb SAKRETE listing scenario is now impossible in three independent layers.
- Free shipping is never a silent policy default — buyer-paid service + per-offer `shippingCostOverrides`, only on the app-created policy.
- Business policies are **never written to a seller's real eBay account without explicit confirmation** of the exact settings (`{ confirm: true }` + proposed-terms UI; publish shows a typed `policies_unconfirmed` CTA until then).
- Failed publishes can't burn credits; republish costs zero credits (spied-module regression).

**Safety/compliance (P0):**
- Beta key removed; every user/AI route requires a Supabase session; billing and rate limiting **fail closed** with retriable 503s — Claude is never called unmetered.
- Persist-before-publish: inventory item + pending attempt row exist before any marketplace call; live-but-unrecorded listings stamp `reconciliation_required` with platform ids. Responses carry `inventoryItemId`/`attemptId`/`reconciliationRequired`.
- X-EBAY-SIGNATURE verified (raw body, ECDSA, 1h key cache) on both webhooks: 412 invalid / 400 malformed / 5xx outage; `notification_receipts` dedupes by notification ID.
- Account deletion actually erases (tokens, identity meta, listing/order ids, raw payloads, cursors) and 500s for retry on failure.
- Dead image URLs can't publish (per-URL preflight + `/api/health` bucket assertion).

**eBay compliance (Phase 2):**
- Immutable `ebayUserId` (+ username, registration marketplace) captured at OAuth under `commerce.identity.readonly`; unidentifiable connections refused; pre-identity connections flagged for reconnect.
- Deterministic SKU (`snap-${itemId}`) + offer reuse: retries cannot duplicate listings (published → returned as-is; unpublished → updated; race → adopted).
- `listingDuration: "GTC"`; leaf-category validation with **no hardcoded fallback**; publish **blocks** on missing REQUIRED aspects; image cap 24 with seller originals first and **no stock-photo fallback anywhere**; order polling paginates.
- Oversell races: urgent dashboard alert + top next-best-action; orders are **never auto-cancelled**.

**Product honesty (Phase 4):** every "list it everywhere / never oversell" claim replaced with the verified-state promise + explicit simultaneous-sale disclosure.

**Infra (Phase 5):** `npm audit --omit=dev` = **0** (was 1 high + 2 moderate); Next 16 `proxy.ts` with nested-route protection and fail-closed auth (the `/inventory/[id]` page was reachable signed-out until this); Node 24 pinned; Supabase isolation blast-radius doc.

## Remaining, by priority

**P0 (before any beta traffic):**
1. Camilo: review/merge PR stack #25→#30 **in order**; apply migrations `20260712000000/010000/020000` on merge.
2. Camilo: flip `listing-photos` bucket to public (verify via `GET /api/health`).
3. Camilo: reconnect the production eBay account (identity scope) — Channels page will prompt.
4. Supervised eBay **sandbox** run (script in Phase 6 section of `docs/LAUNCH_HARDENING.md`): fresh connect → identity/location/policy confirm → publish → retry-no-duplicate → paid-order fixture → sold claim → cross-channel delist; send eBay portal test notifications (deletion + order) and verify 412/400/200 + DB effects.
5. Camilo: register the production webhook endpoints in the eBay developer portal (order events + account deletion) so signed notifications actually flow.

**P1 (before scale):** Vercel Pro for the 15-min polling backstop (Hobby rejected `*/15`, deploy-verified); dedicated Supabase project (isolation doc); Supabase leaked-password toggle + SMTP; Metadata API condition-policy/product-identifier checks; image dimension (≥500px)/watermark validation; recommended-aspects prompts in the draft editor; authenticated E2E suite (signup→publish→billing) — unit/contract coverage is 311 tests, but no browser E2E exists yet.

**P2:** Stripe test-mode full cycle rehearsal; Etsy/Shopify end-to-end verification (currently labeled EARLY); Phase 7 analytics/funnel + UTM + opt-out; support email, spend alerts, backups, error notifications.

## eBay compliance matrix

| Requirement | Status | Where |
|---|---|---|
| GTC listing duration | ✅ tested | `buildEbayOfferPayload` |
| Deterministic retry, no dup listings | ✅ tested | `ebaySkuForItem` + offer reuse |
| Leaf category, no fallback | ✅ tested | `resolveLeafCategory` |
| Required aspects block | ✅ tested | `missingRequiredAspects` |
| Condition enum | ✅ (map) / condition-policy Metadata API ☐ P1 | `EBAY_CONDITION_MAP` |
| Picture policy (count/order/no stock) | ✅ (24/originals-first/none) / px+watermark ☐ P1 | payload builder |
| Identity capture + reconnect | ✅ tested | `ebayExchangeCode`, `needsReconnect` |
| Signature verification (412/400/5xx) | ✅ tested | `ebay-signature.ts` + both webhooks |
| Account deletion erasure + retry | ✅ tested | `ebay-deletion.ts` |
| Order polling pagination | ✅ | `fetchEbaySales` |
| Notifications + polling backstop | ✅ signed webhooks + daily poll (15-min blocked on Vercel Pro) | webhooks, `vercel.json` |
| No auto-cancel on oversell | ✅ + urgent UI alert | `sold-events.ts`, dashboard |

## Production checklist (Camilo)

1. Merge #25 → #26 → #27 → #28 → #29 → #30; apply the three new migrations.
2. Bucket public → `GET /api/health` green.
3. Reconnect eBay (identity scope). 4. Register webhook endpoints in the eBay portal (tokens already in env). 5. Supabase dashboard: leaked-password protection, SMTP. 6. Keep `PIPELINE_LIVE_PUBLISH=false` (auto-pipeline stays dry-run; human publishes are real). 7. Sandbox scenario + portal test notifications. 8. Then, and only then, invite beta sellers.

## Beta metrics to watch (before any ad spend)

- ≥30 successful listings via the app; ≥1 verified sale → sold-event → cross-channel delist.
- `publish_attempts`: error rate by typed reason; any `reconciliation_required` rows (target: 0).
- `sold_events` status `oversold` (target: 0); usage_ledger consumed:refunded ratio; credit spend per published listing (target ≤1.2).

## Advertising runbook (Phase 7 — NOT started, deliberately)

Gate: the two beta metrics above + dedicated Supabase project + Vercel Pro. Then: funnel instrumentation (landing→signup→connect→first draft→first publish→failure→sold→delist→billing), UTM persistence + privacy opt-out, support email + incident owner, Anthropic/Vercel/Supabase spend alerts, DB backups, error notifications. No ads until every box is checked.

## Every PR in this run

| PR | Phase | State |
|---|---|---|
| #25 | 0 — consolidation (folds #22/#23/#24; ports #20's DB-truth pieces) | open, draft |
| #26 | 1 — P0 safety (fail-closed, persist-first, signatures, deletion, policy confirmation) | open, draft |
| #27 | 2 — eBay compliance (identity, SKU, categories/aspects, polling) | open, draft |
| #28 | 4 — honest copy | open, draft |
| #29 | 5 — deps/proxy/isolation | open, draft |
| #30 | final report + punch list | open, draft |
| Closed as superseded | #7 #8 #10 #11 #13–#16 (in merged #19) · #20 (ported) · #22 #23 #24 (folded into #25) | closed |

Full per-item detail and resume state: `docs/LAUNCH_HARDENING.md`.
