// Public landing page — the destination for ads and shared links (roadmap
// Gate 4: public reseller acquisition). Signed-out visitors to "/" land here
// via middleware; signed-in users go straight to the app.

import Link from "next/link";
import { BrandWordmark } from "@/app/brand";

export const metadata = {
  title: "Photograph it. AI drafts your eBay listing.",
};

const STEPS = [
  {
    title: "Snap",
    text: "One photo from your phone. AI reads the brand, model, condition, specs — even the barcode.",
  },
  {
    title: "Review",
    text: "A ready-to-review draft with the break-even floor and low-confidence fields flagged. Nothing publishes until you approve it.",
  },
  {
    title: "Publish to eBay",
    text: "eBay live via the official Sell API you authorize with OAuth (beta). Facebook Marketplace and OfferUp get an assisted copy-paste post; Etsy, Shopify, and a direct checkout link are early and clearly labeled in Channels.",
  },
];

const PILLARS = [
  {
    title: "Monitored inventory sync",
    text: "Sales are detected by verified eBay notifications plus a daily sweep, and other channels are then delisted for you. Sync is monitored, not instantaneous — a simultaneous sale can still require you to cancel or refund one order.",
  },
  {
    title: "Know what made money",
    text: "Every item tracks where it's listed, what it sold for, and your cost — so profit is a number, not a guess.",
  },
  {
    title: "Built on official APIs",
    text: "Real marketplace integrations with OAuth you approve — no password sharing, no fragile browser bots.",
  },
];

export default function WelcomePage() {
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl flex flex-col gap-10">
        {/* Hero */}
        <div className="text-center flex flex-col gap-4">
          <div className="flex justify-center">
            <BrandWordmark markClassName="w-8 h-8" textClassName="text-xl" />
          </div>
          <h1 className="text-4xl font-bold text-gray-900 leading-tight">
            Photograph it.
            <br />
            <span className="text-brand-gradient">
              AI drafts your eBay listing.
            </span>
          </h1>
          <p className="text-gray-500 max-w-md mx-auto">
            Snap to List turns one photo into an eBay-ready draft you review
            and publish through eBay&apos;s official API — with monitored
            inventory sync across your channels. Currently in beta, US
            sellers, eBay first.
          </p>
          <div className="flex gap-3 justify-center">
            <Link
              href="/login"
              className="px-6 py-3 rounded-xl btn-primary font-semibold text-sm transition-colors"
            >
              Start free — 10 AI drafts
            </Link>
            <Link
              href="/pricing"
              className="px-6 py-3 rounded-xl border border-gray-200 bg-white text-gray-700 font-medium text-sm hover:bg-gray-50 transition-colors"
            >
              See pricing
            </Link>
          </div>
          <p className="text-xs text-gray-400">
            No credit card required · cancel anytime
          </p>
        </div>

        {/* How it works */}
        <div className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
            >
              <p className="text-xs font-semibold text-blue-600">STEP {i + 1}</p>
              <p className="font-semibold text-gray-900 mt-1">{step.title}</p>
              <p className="text-sm text-gray-500 mt-1">{step.text}</p>
            </div>
          ))}
        </div>

        {/* Pillars */}
        <div className="flex flex-col gap-3">
          {PILLARS.map((pillar) => (
            <div
              key={pillar.title}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
            >
              <p className="font-semibold text-gray-900">{pillar.title}</p>
              <p className="text-sm text-gray-500 mt-1">{pillar.text}</p>
            </div>
          ))}
        </div>

        {/* Second CTA */}
        <div className="text-center">
          <Link
            href="/login"
            className="inline-block px-8 py-3 rounded-xl btn-primary font-semibold text-sm transition-colors"
          >
            List your first item →
          </Link>
        </div>

        {/* Footer */}
        <footer className="flex justify-center gap-4 text-xs text-gray-400 pb-4">
          <Link href="/help" className="hover:underline">
            Help
          </Link>
          <Link href="/pricing" className="hover:underline">
            Pricing
          </Link>
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
        </footer>
      </div>
    </main>
  );
}
