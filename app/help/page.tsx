// Public help & support page (roadmap Gate 3: "Support email, help docs …
// are published"; onboarding education without sounding like documentation).

import Link from "next/link";

export const metadata = {
  title: "Help & Support",
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
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="font-semibold text-gray-900 mb-2">{title}</h2>
      <div className="text-sm text-gray-600 leading-relaxed flex flex-col gap-2">
        {children}
      </div>
    </section>
  );
}

export default function HelpPage() {
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <div className="text-center mb-2">
          <h1 className="text-2xl font-bold text-gray-900">Help & Support</h1>
        </div>

        <Section title="Your first listing in 3 steps">
          <p>
            1. <strong>Snap</strong> — tap the camera box and photograph your
            item. Good light and a visible label/barcode give the AI the most
            to work with.
          </p>
          <p>
            2. <strong>Review</strong> — check the draft. Fields marked
            <span className="mx-1 text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">⚠ review</span>
            are the AI being honest about uncertainty — verify those before
            publishing. Set your price.
          </p>
          <p>
            3. <strong>Publish</strong> — pick your channels and tap once. Each
            channel reports back with a live link or clear error.
          </p>
        </Section>

        <Section title="Connecting your channels">
          <p>
            <strong>eBay</strong> — connect from{" "}
            <Link href="/channels" className="text-blue-600 hover:underline">
              Channels
            </Link>
            . Your eBay account needs business policies (eBay → Account →
            Business policies) — most active seller accounts already have them.
          </p>
          <p>
            <strong>Etsy</strong> — your shop needs at least one shipping
            profile (Shop Manager → Settings → Shipping). Heads-up: activating
            a listing incurs Etsy&apos;s $0.20 fee, and Etsy allows
            handmade/vintage/craft items only.
          </p>
          <p>
            <strong>Shopify</strong> — enter your{" "}
            <code className="text-xs bg-gray-100 px-1 rounded">
              your-store.myshopify.com
            </code>{" "}
            domain on the Channels page and approve the app.
          </p>
          <p>
            <strong>Facebook Marketplace & OfferUp</strong> — these platforms
            don&apos;t offer listing APIs, so publishing gives you a one-tap
            kit: listing text copied, photo saved, their posting page opened.
            Paste, attach, post.
          </p>
        </Section>

        <Section title="Inventory sync — what it does and doesn't guarantee">
          <p>
            Every published item lives in your{" "}
            <Link href="/inventory" className="text-blue-600 hover:underline">
              Inventory
            </Link>
            . When a sale is detected, other listings for that item are ended
            for you: eBay sales arrive via signed eBay notifications plus a
            daily polling sweep; direct-link sales sync via Stripe webhooks.
            Sales on Facebook/OfferUp: tap <strong>Mark sold</strong> and the
            rest is delisted for you.
          </p>
          <p>
            <strong>Honest limitation:</strong> sync is monitored, not
            instantaneous. If two buyers purchase the same item on different
            channels within the detection window, one order will need a
            cancellation or refund — the dashboard flags this urgently, and
            Snap to List never cancels an order on your behalf.
          </p>
          <p>
            A red <strong>⚠</strong> chip on a listing means a delist failed
            (usually an expired connection) — reconnect the channel and run the
            action again; it retries automatically.
          </p>
        </Section>

        <Section title="AI credits & billing">
          <p>
            1 credit = 1 AI draft from a photo. Editing, publishing, and
            syncing never cost credits. Credits renew monthly with your plan
            and don&apos;t roll over. When you hit zero, drafting pauses but
            your inventory, connections, and listings keep working. Manage
            everything in{" "}
            <Link href="/billing" className="text-blue-600 hover:underline">
              Billing
            </Link>
            .
          </p>
        </Section>

        <Section title="Troubleshooting">
          <p>
            <strong>&quot;Your eBay account has no business policies&quot;</strong> —
            create them at eBay → Account → Business policies, then publish
            again.
          </p>
          <p>
            <strong>&quot;Your Etsy shop has no shipping profile&quot;</strong> — add
            one in Etsy Shop Manager → Settings → Shipping.
          </p>
          <p>
            <strong>Sales aren&apos;t syncing from eBay/Etsy</strong> — reconnect
            the channel from the Channels page; sale detection needs
            permissions added after early accounts connected.
          </p>
          <p>
            <strong>&quot;Could not analyze this photo&quot;</strong> — try a clearer,
            closer photo under 5 MB with the item filling the frame.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Stuck, found a bug, or have a feature request? Email{" "}
            <a
              className="text-blue-600 hover:underline"
              href={`mailto:${CONTACT_EMAIL}`}
            >
              {CONTACT_EMAIL}
            </a>{" "}
            — we read everything.
          </p>
        </Section>

        <Link
          href="/"
          className="text-sm text-blue-600 hover:underline text-center py-2"
        >
          ← Back to Snap to List
        </Link>
      </div>
    </main>
  );
}
