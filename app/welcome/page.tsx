// Public landing page — the destination for ads and shared links (roadmap
// Gate 4: public reseller acquisition). Signed-out visitors to "/" land here
// via middleware; signed-in users go straight to the app.

import Link from "next/link";

export const metadata = {
  title: "Photograph it. It's listed everywhere.",
};

const STEPS = [
  {
    title: "Snap",
    text: "One photo from your phone. AI reads the brand, model, condition, specs — even the barcode.",
  },
  {
    title: "Review",
    text: "A ready-to-publish draft in seconds. Low-confidence fields are flagged so you stay in control.",
  },
  {
    title: "Publish everywhere",
    text: "eBay, Etsy, and Shopify live via their official APIs. Facebook Marketplace and OfferUp with a one-tap assisted post. Plus your own no-fee checkout link.",
  },
];

const PILLARS = [
  {
    title: "Never oversell",
    text: "Sell an item anywhere — including your direct link — and it's automatically delisted from every other channel. eBay, Etsy, and Shopify sales are detected for you.",
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
          <h1 className="text-4xl font-bold text-gray-900 leading-tight">
            Photograph it.
            <br />
            It&apos;s listed everywhere.
          </h1>
          <p className="text-gray-500 max-w-md mx-auto">
            Snap to List turns one photo into live listings on eBay, Etsy,
            Shopify, and more — then keeps every channel in sync so you never
            sell the same item twice.
          </p>
          <div className="flex gap-3 justify-center">
            <Link
              href="/login"
              className="px-6 py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition-colors"
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
            className="inline-block px-8 py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition-colors"
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
