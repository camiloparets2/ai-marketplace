# TODOS

## Phase 2 Launch Blockers (multi-platform publishing is built — these unblock it)

### [ ] Finish eBay Developer Program approval + configure OAuth
**What:** Complete the developer.ebay.com application (below), then create a keyset, set the OAuth "accepted" URL to `{APP_URL}/api/oauth/ebay/callback`, and fill `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_POSTAL_CODE` in Vercel. Test end-to-end with `EBAY_ENV=SANDBOX` first.
**Why:** The eBay publish pipeline (`lib/platforms/ebay.ts`) is live-ready but cannot run without credentials.

### [ ] Apply for an Etsy Open API v3 key
**What:** Request an API key at etsy.com/developers ("commercial" access for a listing tool), set the redirect URI to `{APP_URL}/api/oauth/etsy/callback`, fill `ETSY_API_KEY`.
**Why:** Etsy publishing (`lib/platforms/etsy.ts`) is built and waiting on the key. Etsy approval usually takes days, not weeks.
**Note:** Etsy policy allows handmade/vintage/craft supplies — general resale items belong on eBay/FB/OfferUp, not Etsy. The `ETSY_WHO_MADE`/`ETSY_WHEN_MADE` env defaults assume vintage resale.

### [ ] Apply the platform_connections migration + verify Supabase env vars
**What:** `supabase db push` (or run `supabase/migrations/20260702000000_platform_connections.sql` in the SQL editor); set `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
**Why:** OAuth tokens and hosted listing photos both live in Supabase; without it, eBay/Etsy connect flows fail with a clear config error.

### [ ] Facebook Marketplace / OfferUp: revisit API access quarterly
**What:** Facebook only exposes Marketplace listing APIs to approved Commerce Platform partners; OfferUp has no public API. The app ships an assisted-post flow (copy + photo + deep link) for both. Re-check partner program availability quarterly; if approved, swap the assist flow for a live publish in `lib/platforms/`.

## Phase 1 Parallel Actions (do while building this weekend)

### [ ] Apply for eBay Developer Program
**What:** Apply at developer.ebay.com for sandbox credentials and API access.
**Why:** eBay API approval takes 1-3 weeks (policy review). If you wait until Phase 2, publishing gets delayed by up to a month after validation passes. Start the clock now.
**How to apply:** Create developer account, describe use case ("AI-assisted listing tool for individual sellers, reading/writing eBay listings via Trading API"), request Production access.
**Effort:** ~1 hour.
**Depends on:** Nothing. Do in parallel with Phase 1 build.

### [ ] Set Anthropic API spend alerts before sharing the Vercel URL
**What:** In console.anthropic.com → Billing → Usage limits: set soft alert at $25/month, hard limit at $50/month.
**Why:** API key leak or accidental URL sharing creates unbounded cost exposure. A spend alert catches runaway usage before it becomes a surprise bill.
**Effort:** 5 minutes.
**Depends on:** Nothing. Do before handing out the URL to test sellers.

---

## Phase 2 Research Questions (after validation data is in)

### [ ] Calibrate or challenge the confidence threshold
**What:** Analyze the Phase 1 Google Sheet validation data: for extractions that were wrong, what was Claude's reported confidence value? Is the 60% threshold well-calibrated, or do high-confidence extractions have meaningful false-positive rates?
**Why:** Claude generates spec values AND confidence scores in the same inference pass. Self-reported confidence is not ground-truth validated. The "needs review" yellow indicator implies confidence > 60 means "trust it" — this may not hold. Returns from wrong specs are the problem this product solves.
**How:** Add a column to the Phase 1 Google Sheet: "Was the extraction wrong despite confidence > 60?" Track frequency. If > 10% of high-confidence extractions are wrong, lower the threshold or add a blanket "AI-generated — always verify" disclaimer.
**Depends on:** Phase 1 validation data (30 test listings).

### [ ] Add Upstash Redis rate limiting
**What:** Replace the Phase 1 API key header protection with proper per-IP rate limiting using @upstash/ratelimit + Upstash Redis.
**Why:** lru-cache rate limiting is broken on Vercel serverless (stateless, multi-instance). API key is fine for 10 known sellers but won't scale when the URL goes semi-public in Phase 2.
**How:** `npm install @upstash/ratelimit @upstash/redis` → connect Upstash via Vercel integration → 3-line rate limiter in `/api/analyze`.
**Depends on:** Phase 2 public URL distribution.
