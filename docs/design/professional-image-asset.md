# Design Doc — Professional Image Asset ("Enhance Photo")

**Status:** Draft — pending approval
**Author:** Camilo (via `/office-hours`)
**Date:** 2026-04-19
**Feature owner:** TBD
**Related:** `/api/analyze`, Review UI in `app/page.tsx`, eBay/Etsy Phase 2 integration
**Parent roadmap:** Phase 1 MVP → Phase 2 Marketplace Syndication

---

## 1. TL;DR

Add a **user-triggered** `✨ Enhance Photo` button in the Review UI that generates a white-background version of the seller's own photo for use as the **primary thumbnail** on eBay/Etsy/Google Shopping. The seller's unedited photo is always retained as **Condition Proof** in the listing gallery.

Solution B (AI background removal on the user's own photo) is chosen. **Solution A (stock-photo search via SerpApi/Vertex AI) is rejected** due to unacceptable VeRO takedown risk.

**Phase 1a:** Fake-door test — ship the button, log clicks, show "Coming soon" toast. Gate build decision on **≥40% CTR across 50+ sessions**.
**Phase 1b:** If CTR threshold met, integrate background-removal API behind a **$15 minimum listing price gate**.

---

## 2. Problem Statement

Sellers on eBay and Etsy need two kinds of photos per listing:

1. **A clean, white-background "hero" image** — required for eBay/Etsy syndication to **Google Shopping**, which penalizes or rejects listings with cluttered/dark backgrounds, reducing search reach.
2. **Authentic, unedited condition photos** — required for buyer trust and for avoiding "item not as described" disputes.

Today, Snap to List produces the second but not the first. Sellers resort to ring lights, lightboxes, or manual lasso cutouts on their phone — a **10–20 minute chore per item** that defeats the entire "snap to list" value prop.

**The feature must produce a search-engine-optimized hero image without replacing the real condition photos, and without introducing IP/VeRO risk.**

---

## 3. User Persona

**The Time-Starved Flipper** — 10–30 items/week.

| Trait | Detail |
|---|---|
| Volume | Not Grandma (3/yr), not a warehouse (500/wk). Sustained side-hustle volume. |
| Pain | Every minute spent editing photos is time not sourcing more inventory. |
| Quality bar | Good enough to win the click on Google Shopping. Not studio-grade. |
| Trust bar | Willing to trust AI **if** they can see a side-by-side preview before accepting. |
| Price sensitivity | Cares about per-listing margin on items $5–$50. Insensitive above $50. |

**Non-targets (explicitly not optimizing for):**
- One-time casual sellers (they won't click the button; they don't list to Google Shopping meaningfully).
- High-end power sellers with existing studio workflows (our output won't beat their Photoshop).

---

## 4. Goals & Non-Goals

### Goals

- Produce a clean, white-background hero image from the user's own photo.
- Keep the original photo in the listing as **Condition Proof** (legal/dispute mitigation).
- Keep per-listing cost ≤ **$0.20** on enhanced listings.
- Zero IP/VeRO risk.
- User must see before/after side-by-side and explicitly accept the enhanced image.
- Validate demand with a fake-door test **before** integrating the paid API.

### Non-Goals

- **Not** replacing the user's photo — only generating an additional asset.
- **Not** doing automatic enhancement — always user-triggered.
- **Not** supporting video or multi-angle compositing in v1.
- **Not** offering the feature on listings priced below **$15** (unit-economics gate).
- **Not** building a user account system in this feature (premium tier is Phase 2).
- **Not** fetching external stock imagery under any circumstances (see §5).

---

## 5. Solution Decision

### Chosen: Solution B — AI Background Removal on User's Own Photo

### Rejected: Solution A — Stock-Image Search (SerpApi / Vertex AI)

### Comparison

| Dimension | A: Stock Search | B: Background Removal | Winner |
|---|---|---|---|
| **IP / VeRO risk** | **High.** Sony, Nike, Apple, LEGO, Disney patrol aggressively. Takedowns suspend accounts, not just listings. | **None.** Seller owns the input photo. | **B** |
| **Legal exposure to us** | High — we'd be facilitating use of copyrighted images. | Low — user uploaded the source. | **B** |
| **Cost/call** | ~$0.015 (SerpApi per search) + engineering to filter relevant results. | ~$0.05–0.20 (Remove.bg / Photoroom / Cloudinary). | A cheaper, but moot |
| **Fidelity to the actual item** | Low — stock photos show a *different unit*, potentially a different revision/colorway. Dispute bait. | High — same physical item the buyer receives. | **B** |
| **Failure mode** | Wrong product, wrong color, account ban. | Ugly cutout (recoverable — user rejects in preview). | **B** |
| **Blocked by infra** | Yes — Google Custom Search 403s post Jan-2026 policy; SerpApi workaround is a scraper, fragile. | No — mature APIs (Remove.bg, Photoroom, Replicate). | **B** |
| **Defensibility** | None — anyone can scrape Google. | Modest — integrates with our extraction pipeline. | **B** |

**Decision:** Solution A is killed permanently. **Do not revisit even if the 403 issue resolves.** VeRO risk alone disqualifies it.

### API Vendor Shortlist for Solution B (to decide in 1b)

| Vendor | Cost/call | Pros | Cons |
|---|---|---|---|
| **Remove.bg** | ~$0.20 (subscription amortized) | Best-in-class quality, stable API | Most expensive |
| **Photoroom** | ~$0.09 | Good quality, product-photo tuned | API less mature |
| **Cloudinary AI Background Removal** | ~$0.05–0.10 | Bundled with CDN if we use it | Quality slightly behind Remove.bg |
| **Replicate (BiRefNet / RMBG-2.0)** | ~$0.002–0.01 | Cheapest, open models | Latency variable, quality inconsistent on reflective items |

**Lean:** Start with **Photoroom** (best quality/price balance for product photos). Revisit after 100 real enhancements.

---

## 6. UX Flow

### States in the Review UI

```
[Extracted fields shown as today]
        │
        ▼
┌────────────────────────────────────┐
│  Your photo                        │
│  [original thumbnail]              │
│                                    │
│  Price: $___                       │
│                                    │
│  [ ✨ Enhance Photo ]  ← only      │
│     renders if price >= $15        │
└────────────────────────────────────┘
        │ (click)
        ▼
┌────────────────────────────────────┐
│  Enhancing… (spinner, ~3–8s)       │
└────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────┐
│  Side-by-side preview              │
│  ┌──────────┐   ┌──────────┐       │
│  │ Original │   │ Enhanced │       │
│  └──────────┘   └──────────┘       │
│                                    │
│  [ Use Enhanced ]  [ Keep Original ]│
│                                    │
│  ℹ️  Your original photo stays in   │
│     the listing as Condition Proof.│
└────────────────────────────────────┘
```

### Button visibility rules

| Condition | Button state |
|---|---|
| Price field empty or < $15 | Hidden, with helper text: *"Enhance available for listings $15+"* |
| Price ≥ $15, fake-door phase | Visible; click shows *"Coming soon — we're measuring interest"* toast + logs event |
| Price ≥ $15, live phase | Visible; click runs enhancement pipeline |
| Enhancement in progress | Disabled, shows spinner |
| Enhancement failed | Re-enabled with *"Try again"* label |

### Critical UX rules (non-negotiable)

1. **Never auto-apply** the enhanced image. Always show side-by-side preview.
2. **Original is always retained** in the listing gallery, labeled "Condition Proof."
3. **Enhanced image is explicitly labeled** internally as `role: primary_thumbnail`, original as `role: condition_proof`.
4. User can toggle back to the original at any point before submission.

---

## 7. Unit Economics & Pricing Gate

### Per-listing cost (with enhancement)

| Line item | Cost |
|---|---|
| Claude Vision extraction | ~$0.01 |
| Photoroom background removal | ~$0.09 |
| Stripe fees (on $15 sale) | $0.74 (2.9% + $0.30) |
| **Total variable cost on $15 listing** | **~$0.84** |
| **Margin retained** | $14.16 / 94.4% |

### Why $15 gate

- At $5 item: $0.09 API + $0.45 Stripe = **$0.54 of a $5 sale = 10.8%** margin drag from one API call. Unacceptable.
- At $15 item: $0.09 API = **0.6% of sale price** — negligible.
- Gate avoids subsidizing low-ticket users while preserving the feature where it matters.

### Phase 2 (premium tier)

Once user accounts ship:
- **Free tier:** 3 enhancements/month (we eat the cost as acquisition).
- **Paid tier ($X/mo):** Unlimited, cost-covered by subscription margin.
- This doc does **not** specify pricing — Phase 2 decision.

---

## 8. Fake-Door Validation (Phase 1a)

### What ships first

- The `✨ Enhance Photo` button in the Review UI, gated by the $15 price rule.
- Click handler:
  1. Logs an event to a lightweight analytics sink (console in dev; TBD in prod — likely a single Supabase `events` table insert or a Vercel Analytics custom event).
  2. Shows a toast: *"✨ Enhance Photo is coming soon. We're measuring interest — thanks!"*
  3. Does **not** call any enhancement API.

### Event schema (minimal)

```json
{
  "event": "enhance_photo_click",
  "session_id": "<anonymous uuid>",
  "price_usd": 24.99,
  "extracted_brand": "Sony",
  "extracted_category": "Electronics > Headphones",
  "timestamp": "2026-04-19T12:34:56Z"
}
```

### Kill / build criteria

| Metric | Threshold | Action |
|---|---|---|
| CTR across ≥50 eligible sessions (price ≥ $15) | **< 20%** | Kill feature. Remove button. |
| CTR across ≥50 eligible sessions | **20–40%** | Extend test to 150 sessions; reassess. |
| CTR across ≥50 eligible sessions | **≥ 40%** | Proceed to Phase 1b (API integration). |

**Minimum test window:** 14 days or 50 qualifying sessions, whichever is longer.

**Definition of "qualifying session":** A session that reaches the Review stage with a price ≥ $15 entered.

---

## 9. API & Schema Changes

### 9.1 `/api/analyze` — No breaking changes

`/api/analyze` continues to return the same `ExtractionResult` shape. It does **not** trigger image enhancement. Enhancement is a **separate, user-triggered call**.

**Rationale:** Keeps extraction fast, cheap, and independent of the optional enhancement flow. Prevents accidental API spend on users who never click the button.

### 9.2 New endpoint: `POST /api/enhance-image` (Phase 1b only — not built during fake-door phase)

**Request:**
```ts
{
  image: string;         // base64-encoded JPEG/PNG
  session_id?: string;   // for cost attribution
}
```

**Response (success):**
```ts
{
  enhanced_image: string;  // base64-encoded JPEG with white background
  vendor: "photoroom";     // for cost tracking
  latency_ms: number;
}
```

**Response (error):**
```ts
{
  error: string;
  code: "RATE_LIMITED" | "VENDOR_ERROR" | "BAD_IMAGE" | "TIMEOUT";
  retryable: boolean;
}
```

**Auth:** Same `x-api-key` header as existing routes (Phase 1).
**Timeout:** 15s wall clock.
**Image size limit:** Same 5 MB limit as upload pipeline.

### 9.3 Client-side state additions (`app/page.tsx`)

Extend the stage machine:

```ts
type Stage =
  | "idle"
  | "preparing"
  | "analyzing"
  | "review"
  | "enhancing"        // NEW
  | "enhance_preview"  // NEW
  | "generating"
  | "done"
  | "error";
```

Extend the review state to track both images:

```ts
interface ReviewState {
  originalImage: string;          // base64, always present
  enhancedImage: string | null;   // base64, set after successful enhancement
  selectedPrimary: "original" | "enhanced";  // which one is the thumbnail
  // ...existing fields
}
```

### 9.4 Listing payload (Phase 2 — eBay/Etsy integration)

When the marketplace integrations ship, the listing payload will include **both** images with roles:

```ts
{
  images: [
    { url: "...", role: "primary_thumbnail" },   // enhanced if selected, else original
    { url: "...", role: "condition_proof" }      // always the original
  ]
}
```

This is noted for continuity but **not built in this feature**.

---

## 10. Success Criteria

### Phase 1a (fake door)
- ✅ Button ships in Review UI behind $15 gate.
- ✅ Clicks logged with event schema above.
- ✅ Decision (kill / extend / build) made within 30 days of ship, backed by data.

### Phase 1b (if built)
- ✅ Side-by-side preview renders in < 10s (p95) end-to-end.
- ✅ "Use Enhanced" accept rate ≥ 60% among users who click the button (sanity check on output quality).
- ✅ Per-listing enhancement cost ≤ $0.15 (vendor + overhead).
- ✅ Zero VeRO takedowns attributable to this feature (Phase 2 marketplace listings).

### Leading indicator (Phase 2, post eBay/Etsy launch)
- Google Shopping impressions on enhanced listings ≥ 2× impressions on non-enhanced listings (matched-pair comparison).

---

## 11. Rollout Plan

| Step | Action | Gated on |
|---|---|---|
| 1 | Ship fake-door button + event logging. | Design Doc approval. |
| 2 | Collect 50+ qualifying sessions. | 14–30 days of traffic. |
| 3 | Review CTR. Kill / extend / proceed. | §8 thresholds. |
| 4 | Vendor spike: 20 test images on Photoroom + Cloudinary + Replicate. Qualitative review. | Step 3 = proceed. |
| 5 | Build `/api/enhance-image` with chosen vendor. | Step 4 complete. |
| 6 | Ship side-by-side preview + accept flow. | Step 5 complete. |
| 7 | Monitor accept rate + vendor cost for 2 weeks. | — |
| 8 | Revisit vendor choice and pricing gate with real data. | 2 weeks post-launch. |

---

## 12. Risks & Open Questions

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Background removal mangles a visible flaw → buyer dispute | High | Original always retained as Condition Proof. TOS clause. Side-by-side preview. |
| Vendor API price hike / deprecation | Medium | Abstract vendor behind `lib/imageEnhance.ts`; track cost per call. |
| User confusion over "why are there two photos" | Medium | Clear in-UI copy: *"Enhanced for Google Shopping. Original kept for buyers."* |
| Low CTR kills feature but button has already shipped | Low | Feature flag the button for clean removal. |
| Enhanced image looks worse than original for certain categories (reflective, transparent, textile) | Medium | Track accept-rate by category; consider category-based visibility rules in v2. |

### Open Questions (to resolve before Phase 1b)

1. **Where do we log fake-door events?** Vercel Analytics custom event vs. a minimal Supabase table. Leaning Vercel (no new infra).
2. **Do we cache enhanced images?** If user re-enhances the same photo, re-serve or re-bill? Leaning: cache per `(session_id, image_hash)` for 24h.
3. **What happens on mobile data** with two full-size images in state? Confirm compressed variants are used throughout the review UI, not raw 5 MB base64.
4. **Attribution/TOS copy.** Need a short clause explicitly stating the user is responsible for verifying the enhanced image accurately represents the item.
5. **Vendor lock-in.** Should `lib/imageEnhance.ts` support vendor fallback from day one, or is single-vendor fine for v1? Leaning single-vendor for v1, abstract interface from day one.

---

## 13. Approval

- [ ] Problem statement accepted
- [ ] User persona accepted
- [ ] Solution A rejected (VeRO risk)
- [ ] Solution B accepted (background removal on user's own photo)
- [ ] Fake-door validation plan accepted
- [ ] $15 pricing gate accepted
- [ ] Ready to implement Phase 1a (fake-door button + event logging)

---

## 14. Out of Scope (explicit)

- Video enhancement
- Multi-angle / lifestyle composite generation
- AI-generated backgrounds (non-white)
- Automatic application of enhancement without user review
- Stock-photo search or any use of third-party product imagery
- User account system / premium tier (Phase 2)
- eBay/Etsy API integration (Phase 2)
