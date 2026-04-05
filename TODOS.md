# TODOS

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
