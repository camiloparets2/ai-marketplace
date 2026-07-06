// Public terms of service — launch-grade draft: eligibility, subscriptions/
// credits/refunds, acceptable use, AI disclaimer, marketplace relationships,
// IP, warranty disclaimer, liability cap, termination. Accurate to how the
// product actually behaves; have a licensed attorney confirm (and pin the
// governing-law state) before large-scale paid launch.

import Link from "next/link";

export const metadata = {
  title: "Terms of Service",
};

const CONTACT_EMAIL = "camiloparets2@gmail.com";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="font-semibold text-gray-900 mb-1">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <article className="w-full max-w-2xl bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-6 text-gray-700 text-sm leading-relaxed">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Terms of Service</h1>
          <p className="text-gray-400 mt-1">
            Snap to List · Effective July 6, 2026
          </p>
          <p className="mt-2">
            These terms are a contract between you and Snap to List
            (&quot;we&quot;, &quot;us&quot;). By creating an account or using
            the service you agree to them. Plain-language summaries are
            included for readability; the full text controls.
          </p>
        </header>

        <Section title="1. The service">
          <p>
            Snap to List generates marketplace listings from your product
            photos using AI, publishes them to marketplaces you connect,
            tracks your inventory, and synchronizes listings across channels
            when items sell. Features may change as the product evolves; we
            will not materially reduce what a paid plan includes mid-cycle
            without notice.
          </p>
        </Section>

        <Section title="2. Eligibility and your account">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>You must be at least 18 and able to form a contract.</li>
            <li>
              You may only connect marketplace accounts and stores you own or
              are authorized to manage.
            </li>
            <li>
              You are responsible for your account credentials and for all
              activity under your account. Tell us immediately if you suspect
              unauthorized access.
            </li>
          </ul>
        </Section>

        <Section title="3. Subscriptions, credits, and refunds">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              Paid plans bill monthly through Stripe and{" "}
              <strong>renew automatically</strong> until cancelled. Cancel
              anytime from the billing portal; access continues to the end of
              the paid period.
            </li>
            <li>
              Plans include monthly <strong>AI credits</strong> (1 credit = 1
              AI listing draft). Credits reset each billing period and do not
              roll over. Editing, publishing, and syncing never consume
              credits. If a draft fails to generate, the credit is returned.
            </li>
            <li>
              When credits run out, AI drafting pauses until renewal or
              upgrade; your inventory, listings, connections, and data remain
              fully accessible.
            </li>
            <li>
              Except where the law requires otherwise, payments are
              non-refundable and we don&apos;t prorate partial periods. If we
              materially fail to provide the service, contact us and
              we&apos;ll make it right.
            </li>
            <li>
              We may change prices with at least 14 days&apos; notice; changes
              apply from your next billing period.
            </li>
            <li>
              The free trial (10 credits) is one per person; creating accounts
              to farm trials isn&apos;t allowed.
            </li>
          </ul>
        </Section>

        <Section title="4. Your content and AI drafts">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              <strong>You own your photos and listings.</strong> You grant us
              a license to host, process, and transmit them solely to provide
              the service (e.g. sending a photo to our AI provider, uploading
              it to a marketplace you selected).
            </li>
            <li>
              <strong>AI output is a draft, not a promise.</strong> Generated
              titles, specs, conditions, and prices can be wrong. Nothing
              publishes without your explicit confirmation, and you are
              responsible for the accuracy and legality of every listing you
              publish.
            </li>
          </ul>
        </Section>

        <Section title="5. Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              list items that are illegal, counterfeit, stolen, recalled, or
              prohibited by the destination marketplace;
            </li>
            <li>
              violate any connected marketplace&apos;s terms, or use the
              service to evade their rules, fees, or enforcement;
            </li>
            <li>
              probe, overload, scrape, or interfere with the service, or
              attempt to access other users&apos; data or bypass usage limits;
            </li>
            <li>resell or white-label the service without our agreement.</li>
          </ul>
          <p>We may suspend accounts that break these rules.</p>
        </Section>

        <Section title="6. Marketplaces are their own bosses">
          <p>
            Snap to List is not affiliated with or endorsed by eBay, Etsy,
            Shopify, Meta, or OfferUp. Your relationship with each marketplace
            — including their fees (e.g. Etsy&apos;s listing fee), policies,
            payouts, and account decisions — is between you and them, governed
            by their terms. We cannot control marketplace outages, API
            changes, listing removals, or account actions, and are not
            responsible for them. Where a platform offers no public API
            (Facebook Marketplace, OfferUp), we provide assisted posting
            tools; the posting itself is done by you in your own account.
          </p>
        </Section>

        <Section title="7. Selling to buyers">
          <p>
            When you sell — on a marketplace or through a direct checkout
            link — <strong>you are the seller</strong>. You are responsible
            for accurate listings, fulfillment, shipping, taxes, returns, and
            buyer service for your items. Cross-channel sync is designed to
            prevent overselling, but you remain responsible for honoring or
            resolving any sale that occurs.
          </p>
        </Section>

        <Section title="8. Disclaimers">
          <p>
            The service is provided <strong>&quot;as is&quot;</strong> and
            &quot;as available.&quot; To the fullest extent permitted by law,
            we disclaim all warranties, express or implied, including
            merchantability, fitness for a particular purpose, and
            non-infringement. We do not warrant uninterrupted or error-free
            operation, that AI output will be accurate, or that listings will
            sell.
          </p>
        </Section>

        <Section title="9. Limitation of liability">
          <p>
            To the fullest extent permitted by law: we are not liable for
            indirect, incidental, special, consequential, or punitive damages,
            or lost profits or revenue; and our total liability for any claim
            arising from the service is capped at the greater of $50 or the
            amount you paid us in the 12 months before the claim. Some
            jurisdictions don&apos;t allow certain limitations — where that
            applies to you, these limits apply to the extent permitted.
          </p>
        </Section>

        <Section title="10. Termination">
          <p>
            You may close your account at any time. We may suspend or
            terminate accounts for breach of these terms, non-payment, or
            legal necessity — with notice where practicable. On termination,
            your subscription ends per Section 3, and you may request export
            or deletion of your data as described in the{" "}
            <Link href="/privacy" className="text-blue-600 hover:underline">
              Privacy Policy
            </Link>
            . Sections 4, and 7–12 survive termination.
          </p>
        </Section>

        <Section title="11. Governing law and disputes">
          <p>
            These terms are governed by the laws of the United States and the
            state in which Snap to List&apos;s operator resides, without
            regard to conflict-of-law rules. Before filing any claim, you
            agree to contact us and give us 30 days to resolve the issue
            informally.
          </p>
        </Section>

        <Section title="12. Changes and contact">
          <p>
            We may update these terms; material changes will be announced by
            email or in the app at least 14 days before they take effect, and
            continued use after that constitutes acceptance. Questions:{" "}
            <a
              className="text-blue-600 hover:underline"
              href={`mailto:${CONTACT_EMAIL}`}
            >
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <Link href="/" className="text-blue-600 hover:underline text-sm">
          ← Back to Snap to List
        </Link>
      </article>
    </main>
  );
}
