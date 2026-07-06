// OAuth "accepted" landing alias. The eBay Developer Portal RuName is
// configured with /connect/{platform}/success as a post-consent destination;
// the app's real success signal is the ?connected= query param on the home
// page, so this page just forwards there. Kept as a redirect (not a UI) so
// there is exactly one place that renders connection status.

import { redirect } from "next/navigation";

export default async function ConnectSuccessPage({
  params,
}: {
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await params;
  redirect(`/?connected=${encodeURIComponent(platform)}`);
}
