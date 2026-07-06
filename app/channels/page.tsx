"use client";

// Channel hub — the Shopify-style marketplace settings experience from the
// roadmap: connection status per channel, account labels, last sale sync,
// connect/reconnect actions, and honest labeling for assisted channels.
// Multi-account-per-marketplace is designed for but not yet built (roadmap
// Phase 3 follow-up). Signed-out visitors are bounced to /login.

import { useEffect, useState } from "react";
import Link from "next/link";

interface ChannelStatus {
  platform: "ebay" | "etsy" | "shopify";
  connected: boolean;
  accountLabel: string | null;
  lastSyncedAt: string | null;
}

const CHANNEL_META: Record<
  ChannelStatus["platform"],
  { name: string; blurb: string }
> = {
  ebay: { name: "eBay", blurb: "Live listings via the Sell Inventory API" },
  etsy: { name: "Etsy", blurb: "Live listings via Open API v3" },
  shopify: { name: "Shopify", blurb: "Your own storefront — no marketplace fees" },
};

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [shopDomain, setShopDomain] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectError = params.get("connect_error");
    if (connectError) {
      queueMicrotask(() => setError(connectError));
      window.history.replaceState({}, "", window.location.pathname);
    }

    void fetch("/api/channels")
      .then((res) => {
        if (res.status === 401) {
          window.location.assign("/login?next=/channels");
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: { channels?: ChannelStatus[] } | null) => {
        if (data?.channels) setChannels(data.channels);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  function connectShopify(e: React.FormEvent) {
    e.preventDefault();
    const shop = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "");
    window.location.assign(
      `/api/oauth/shopify/start?shop=${encodeURIComponent(shop)}`
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Channels</h1>
          <p className="text-sm text-gray-500 mt-1">
            Connect once — publish and sync everywhere from one workspace.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {channels.map((ch) => (
              <div
                key={ch.platform}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {CHANNEL_META[ch.platform].name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {CHANNEL_META[ch.platform].blurb}
                    </p>
                  </div>
                  {ch.connected ? (
                    <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded">
                      ● Connected
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                      Not connected
                    </span>
                  )}
                </div>

                {ch.connected && (
                  <p className="text-xs text-gray-400">
                    {ch.accountLabel && <>Account: {ch.accountLabel} · </>}
                    {ch.lastSyncedAt
                      ? `Sales last synced ${new Date(ch.lastSyncedAt).toLocaleString()}`
                      : "Sales not synced yet"}
                  </p>
                )}

                {ch.platform === "shopify" && !ch.connected ? (
                  <form onSubmit={connectShopify} className="flex gap-2">
                    <input
                      required
                      placeholder="my-store.myshopify.com"
                      className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={shopDomain}
                      onChange={(e) => setShopDomain(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 transition-colors"
                    >
                      Connect
                    </button>
                  </form>
                ) : (
                  <a
                    href={
                      ch.platform === "shopify"
                        ? ch.accountLabel
                          ? `/api/oauth/shopify/start?shop=${encodeURIComponent(ch.accountLabel)}`
                          : "#"
                        : `/api/oauth/${ch.platform}/start`
                    }
                    className={`text-sm font-medium ${
                      ch.connected
                        ? "text-gray-500 hover:text-gray-700"
                        : "text-blue-600 hover:underline"
                    }`}
                  >
                    {ch.connected ? "Reconnect (refresh permissions) →" : "Connect →"}
                  </a>
                )}
              </div>
            ))}

            {/* Assisted + direct channels — honest labeling */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-gray-900">Direct checkout</p>
                <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded">
                  Always available
                </span>
              </div>
              <p className="text-xs text-gray-500">
                Stripe payment links — created per listing, auto-disabled when
                the item sells anywhere.
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-gray-900">
                  Facebook Marketplace · OfferUp
                </p>
                <span className="text-xs font-medium text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
                  Assisted
                </span>
              </div>
              <p className="text-xs text-gray-500">
                No public listing APIs exist, so publishing gives you a one-tap
                copy-and-paste kit instead of a live post. Sales there are
                recorded with &quot;Mark sold&quot; in inventory.
              </p>
            </div>

            <p className="text-xs text-gray-400 text-center">
              Multiple accounts per marketplace (e.g. two eBay stores) is on
              the roadmap — one account per channel for now.
            </p>
          </>
        )}

        <Link href="/" className="text-sm text-blue-600 hover:underline text-center">
          ← Back to Snap to List
        </Link>
      </div>
    </main>
  );
}
