# Pricing Analysis — Snap to List subscriptions

Decision record for the subscription numbers in `lib/billing/plans.ts`.
Goal set by the owner: a fair margin for **both sides** — the seller's time
saved must dwarf what they pay, and the platform's margin must sustainably
fund AI costs, development, and support.

## The seller's side: what a listing actually costs them

Manual cross-listing one item, measured against marketplace-native tools:

| Step | Manual time |
|---|---|
| Photograph + write eBay listing (title, specifics, condition, price) | 10–15 min |
| Re-post to each additional channel (Etsy, Shopify, FB, OfferUp) | 5–10 min each |
| **Total for 4–5 channels** | **~25–40 min per item** |

Snap to List: photo → review → publish everywhere ≈ **3–5 min**.
**Time saved ≈ 25 min per item.** At a modest $15/hour value of time,
that's **≈ $6.25 of value per listing**.

Fairness test: the seller should pay a small fraction of the value created.
At our prices, sellers pay **$0.08–$0.17 per listing** — i.e. **1–3% of the
time value delivered**. Every plan also costs less per listing than Vendoo,
List Perfectly, or Crosslist equivalents (market range: entry ~$9–30/mo,
serious-seller tiers $29–69/mo, most with lower item caps than ours).

## The platform's side: what a listing costs us

- Claude Vision extraction: ~2.5K input + ~0.6K output tokens ≈ **$0.02/draft**
  (Sonnet-class pricing, headroom included).
- Stripe: 2.9% + $0.30 per subscription charge.
- Vercel/Supabase: fixed, amortized.

Margin floor rule adopted: **≥ 70% gross margin even at 100% credit
utilization** (real utilization for credit SaaS runs 30–60%, so realized
margins will be higher — that headroom funds trials, support, and refunds).

## The numbers

| Plan | Price | Credits/mo | $/listing | Full-util COGS (AI + Stripe) | Worst-case margin |
|---|---|---|---|---|---|
| Free Trial | $0 | 10 (once) | — | $0.20 | acquisition cost |
| Starter | **$9.99** | **60** | $0.17 | $1.20 + $0.59 = $1.79 | **82%** |
| Pro | **$24.99** | **250** | $0.10 | $5.00 + $1.02 = $6.02 | **76%** |
| Power | **$59.99** | **750** | $0.08 | $15.00 + $2.04 = $17.04 | **72%** |

Changes from the placeholders ($9.99/50, $29.99/250, $79.99/1000):

- **Starter 50 → 60 credits**: same price, ~15 items/week — comfortably
  covers a casual reseller and beats Vendoo's entry tier on items included.
- **Pro $29.99 → $24.99**: the anchor tier. Undercuts List Perfectly ($49)
  and Crosslist (~$30–50) for a daily seller while holding 76% worst-case
  margin. Priced to convert — Pro is where the business lives.
- **Power $79.99/1000 → $59.99/750**: same $0.08/listing, but the lower
  sticker converts better and caps our worst-case AI bill; 750/mo (25/day)
  covers genuine high-volume sellers. Raise limits later if data says so.

Sanity check on seller ROI (Pro, full use): 250 listings × 25 min saved
≈ **104 hours/month returned to the seller for $24.99** — under $0.25/hour.
That is the "fair to both sides" outcome: the seller keeps ~97% of the value
created; the platform's worst-case margins stay above 70%.

## Mechanics

- Prices live in `lib/billing/plans.ts`; plan keys double as Stripe price
  lookup keys. `resolvePriceId` verifies the Stripe price amount still
  matches the catalog and mints a new price (moving the lookup key) when it
  doesn't — so future price changes are a one-line edit. Existing
  subscribers keep the price they signed up at unless migrated in Stripe.
- Credits don't roll over (v1); editing/publishing/sync never consume
  credits. Top-ups and annual plans are future options (see roadmap).
