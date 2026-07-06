// Public privacy policy — launch-grade draft covering the standard clauses
// (data categories, purposes, processors, AI disclosure, retention, rights,
// cookies, children, transfers). Reviewed for accuracy against what the app
// actually stores; have a licensed attorney confirm before large-scale paid
// launch, and update this page whenever a new data store ships (wire
// deletions into lib/platforms/ebay-deletion.ts).

import Link from "next/link";

export const metadata = {
  title: "Privacy Policy",
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

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <article className="w-full max-w-2xl bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-6 text-gray-700 text-sm leading-relaxed">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
          <p className="text-gray-400 mt-1">
            Snap to List · Effective July 6, 2026
          </p>
          <p className="mt-2">
            This policy explains what we collect, why, who touches it, and the
            control you have. The short version: we collect what&apos;s needed
            to turn your photos into listings and keep your channels in sync —
            and nothing is ever sold or used for advertising.
          </p>
        </header>

        <Section title="1. What we collect">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              <strong>Account data</strong> — your email address and sign-in
              credentials, managed by Supabase Auth. If you sign in with
              Google, we receive your email from Google; we never see your
              Google password.
            </li>
            <li>
              <strong>Product photos and listing content</strong> — the photos
              you upload and the titles, descriptions, prices, conditions, and
              specifications generated from them or edited by you.
            </li>
            <li>
              <strong>Marketplace connection tokens</strong> — when you connect
              eBay, Etsy, or Shopify, we store the access tokens those
              platforms issue. Tokens are held server-side only, are never
              sent to your browser, and are used solely to publish and manage
              listings you initiate.
            </li>
            <li>
              <strong>Inventory and sale records</strong> — where each item is
              listed, what it sold for and where, and (if you enter it) what
              it cost you, so your channels stay in sync and you can track
              profit.
            </li>
            <li>
              <strong>Billing data</strong> — your subscription plan, credit
              usage, and Stripe customer reference. Payments are processed by
              Stripe; <strong>we never see or store card numbers</strong>.
            </li>
            <li>
              <strong>Technical data</strong> — request logs, IP-based rate
              limiting counters, and error reports needed to keep the service
              running and abuse-free.
            </li>
          </ul>
        </Section>

        <Section title="2. How we use it">
          <p>
            We process data to provide the service you signed up for: analyzing
            photos into listing drafts, publishing to the marketplaces you
            choose, keeping listings in sync when items sell, metering AI
            credits, processing subscriptions, and providing support. We also
            use aggregate, de-identified usage data to improve the product. We
            do <strong>not</strong> sell personal data, share it for
            advertising, or use your photos to train AI models.
          </p>
        </Section>

        <Section title="3. AI processing">
          <p>
            Photos you submit are sent to Anthropic&apos;s Claude API to
            extract listing details. Under Anthropic&apos;s API terms, data
            sent through the API is not used to train their models. AI output
            is a draft: you review and approve everything before it&apos;s
            published anywhere.
          </p>
        </Section>

        <Section title="4. Who else touches your data">
          <p>Service providers acting on our instructions:</p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>Vercel — application hosting</li>
            <li>Supabase — database, authentication, and photo storage</li>
            <li>Anthropic — photo-to-listing analysis</li>
            <li>Stripe — subscription and checkout payments</li>
            <li>
              eBay, Etsy, Shopify — only for accounts <em>you</em> connect, and
              only the listing data needed to publish and sync. Your use of
              those platforms is governed by their own privacy policies.
            </li>
          </ul>
          <p>
            When you publish a listing, its content (including photos) becomes
            public on the marketplaces you selected — that&apos;s the point of
            the product. Photos may be hosted at a public URL when a
            marketplace requires image links.
          </p>
          <p>
            We may also disclose data if required by law, or as part of a
            merger or acquisition (in which case this policy continues to
            apply to data collected under it).
          </p>
        </Section>

        <Section title="5. Retention and deletion">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              Account, inventory, and listing data are kept while your account
              is active.
            </li>
            <li>
              Disconnecting a marketplace deletes its stored tokens.
            </li>
            <li>
              We honor eBay&apos;s marketplace account deletion program: when
              eBay notifies us an eBay user deleted their account, we erase
              associated eBay user data.
            </li>
            <li>
              You can request deletion of your account and data at any time
              (see Contact below); we&apos;ll complete it within 30 days,
              except records we must keep for tax, billing, or legal reasons.
            </li>
          </ul>
        </Section>

        <Section title="6. Security">
          <p>
            Data is encrypted in transit (HTTPS everywhere). Marketplace
            tokens are stored server-side with database access rules that make
            them unreadable from the browser. Payment credentials never touch
            our systems. No method is 100% secure, but we design so that a
            compromised browser session cannot reach your tokens.
          </p>
        </Section>

        <Section title="7. Your rights">
          <p>
            Depending on where you live (including under GDPR and the
            CCPA/CPRA), you may have rights to access, correct, export,
            restrict, or delete your personal data, and to object to certain
            processing. Email us and we&apos;ll honor these requests for all
            users regardless of location, verifying the request via your
            account email. We do not discriminate against you for exercising
            privacy rights.
          </p>
        </Section>

        <Section title="8. Cookies">
          <p>
            We use only functional cookies: your sign-in session and short-
            lived security cookies during marketplace connection flows. No
            advertising or cross-site tracking cookies.
          </p>
        </Section>

        <Section title="9. Children">
          <p>
            Snap to List is for sellers aged 18 and over (marketplaces require
            adults to transact). We do not knowingly collect data from anyone
            under 18; if you believe we have, contact us and we&apos;ll delete
            it.
          </p>
        </Section>

        <Section title="10. International users">
          <p>
            We operate from the United States and process data on U.S.-based
            infrastructure. By using the service you understand your data is
            processed in the U.S.
          </p>
        </Section>

        <Section title="11. Changes and contact">
          <p>
            If we make material changes to this policy we&apos;ll update the
            effective date above and, for significant changes, notify you by
            email or in the app. Questions or requests:{" "}
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
