// OAuth "declined" landing. The eBay Developer Portal RuName sends users here
// when they cancel the consent screen (eBay uses a separate declined URL
// rather than calling the callback with an error). Forward to the home page's
// error banner.

import { redirect } from "next/navigation";

export default async function ConnectDeclinedPage({
  params,
}: {
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await params;
  redirect(
    `/?connect_error=${encodeURIComponent(
      `You declined the ${platform} connection. Connect again whenever you're ready.`
    )}`
  );
}
