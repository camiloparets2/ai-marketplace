// Public terms of service — required by launch roadmap Gate 3 and referenced
// by marketplace developer-portal listings. Kept deliberately short and
// honest for the beta phase; expand alongside billing/subscriptions.

import Link from "next/link";

export const metadata = {
  title: "Terms of Service — Snap to List",
};

const CONTACT_EMAIL = "camiloparets2@gmail.com";

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <article className="w-full max-w-2xl bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-5 text-gray-700 text-sm leading-relaxed">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Terms of Service</h1>
          <p className="text-gray-400 mt-1">Snap to List · Last updated July 2026</p>
        </header>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">The service</h2>
          <p>
            Snap to List generates marketplace listings from your product
            photos and publishes them to marketplaces you connect. It is
            currently in beta; features may change and availability is not
            guaranteed.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">Your listings</h2>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              You are responsible for reviewing AI-generated listing details
              before publishing. Nothing publishes without your explicit
              confirmation.
            </li>
            <li>
              You are responsible for the accuracy of published listings and
              for complying with each marketplace&apos;s policies and fees
              (e.g. Etsy&apos;s listing fee, eBay selling policies).
            </li>
            <li>
              You may only connect marketplace accounts you own or are
              authorized to manage.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">Liability</h2>
          <p>
            The service is provided as-is during beta, without warranties.
            We are not liable for marketplace decisions (listing removals,
            account actions, fees) or for losses arising from listing content
            you approved.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-gray-900 mb-1">Contact</h2>
          <p>
            Questions:{" "}
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
