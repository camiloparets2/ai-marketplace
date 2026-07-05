// Public privacy policy — the eBay Developer Portal requires a working
// privacy URL for a Production keyset, and Gate 3 of the launch roadmap
// requires it before paid beta. Plain-language and honest about what the
// app actually stores today; update this page whenever a new data store
// ships (and wire deletions into lib/platforms/ebay-deletion.ts).

import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Snap to List",
};

const CONTACT_EMAIL = "camiloparets2@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <article className="w-full max-w-2xl bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-5 text-gray-700 text-sm leading-relaxed">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
          <p className="text-gray-400 mt-1">Snap to List · Last updated July 2026</p>
        </header>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">What we collect</h2>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              <strong>Product photos</strong> you upload, and the listing data
              (title, brand, condition, specs, price) generated from them.
            </li>
            <li>
              <strong>Marketplace connection tokens</strong> (eBay, Etsy) when
              you connect an account. These are stored server-side only, are
              never sent to your browser, and are used solely to publish and
              manage listings you initiate.
            </li>
            <li>
              <strong>Payment data</strong> is handled by Stripe. We never see
              or store card numbers.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">How we use it</h2>
          <p>
            Photos are sent to Anthropic&apos;s Claude API to extract listing
            details, and listing data is sent to the marketplaces you choose
            (eBay, Etsy) to create your listings. Photos may be hosted at a
            public URL when a marketplace requires image links. We do not sell
            your data or use it for advertising.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">Service providers</h2>
          <p>
            Vercel (hosting), Supabase (database and storage), Anthropic
            (image analysis), Stripe (payments), eBay and Etsy (listing
            publication, only for accounts you connect).
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">Deletion</h2>
          <p>
            Disconnecting a marketplace removes its stored tokens. We honor
            eBay&apos;s marketplace account deletion notifications and erase
            associated eBay user data when eBay informs us an account was
            closed. To request deletion of anything else we hold about you,
            email{" "}
            <a className="text-blue-600 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">Contact</h2>
          <p>
            Questions about this policy:{" "}
            <a className="text-blue-600 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </section>

        <Link href="/" className="text-blue-600 hover:underline text-sm">
          ← Back to Snap to List
        </Link>
      </article>
    </main>
  );
}
