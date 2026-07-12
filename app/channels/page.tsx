"use client";

// Channel hub — the Shopify-style marketplace settings experience from the
// roadmap: connection status per channel, account labels, last sale sync,
// connect/reconnect actions, and honest labeling for assisted channels.
// Multi-account-per-marketplace is designed for but not yet built (roadmap
// Phase 3 follow-up). Signed-out visitors are bounced to /login.

import { useEffect, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/app/ui/status-badge";

interface ChannelStatus {
  platform: "ebay" | "etsy" | "shopify";
  connected: boolean;
  accountLabel: string | null;
  lastSyncedAt: string | null;
  needsReconnect?: boolean;
  // eBay only — publish-readiness checklist from the API (detect-only).
  ebayReadiness?: {
    shipFrom: boolean;
    policies: "ready" | "missing" | "not_registered" | "unknown";
    // Seller-registration CTA on the seller's own marketplace
    // (ebay.co.uk, ebay.de, …), derived server-side.
    registrationUrl?: string;
    // The EXACT settings policy setup would create — shown for explicit
    // confirmation before anything is written to the seller's eBay account.
    proposedPolicies?: {
      fulfillment: string;
      payment: string;
      returns: string;
    };
  };
}

interface ReadinessFixResponse {
  shipFrom?: boolean;
  policies?: "ready" | "not_registered" | "pending";
  message?: string;
  actionUrl?: string;
  error?: string;
}

const EBAY_POLICY_HELP =
  "Business policies are eBay's shipping, payment, and return terms — every listing needs them. Review the exact settings below; nothing is written to your eBay account until you confirm, and you can edit them on eBay anytime.";

const CHANNEL_META: Record<
  ChannelStatus["platform"],
  { name: string; blurb: string }
> = {
  ebay: {
    name: "eBay",
    blurb: "BETA — live listings via the official Sell Inventory API (OAuth)",
  },
  etsy: {
    name: "Etsy",
    blurb: "EARLY — official API integration built, not yet verified end-to-end",
  },
  shopify: {
    name: "Shopify",
    blurb: "EARLY — official API integration built, not yet verified end-to-end",
  },
};

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [shopDomain, setShopDomain] = useState("");
  const [error, setError] = useState("");
  // "Set up automatically" button state + outcome message for the eBay card.
  const [fixing, setFixing] = useState(false);
  const [fixNotice, setFixNotice] = useState<{
    kind: "success" | "warn";
    text: string;
    actionUrl?: string;
  } | null>(null);

  async function fixEbayReadiness() {
    setFixing(true);
    setFixNotice(null);
    try {
      const res = await fetch("/api/channels/ebay-readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The button sits under the exact proposed settings — clicking it IS
        // the seller's confirmation.
        body: JSON.stringify({ confirm: true }),
      });
      const data = (await res.json()) as ReadinessFixResponse;
      if (!res.ok) {
        setFixNotice({
          kind: "warn",
          text: data.error ?? "eBay setup failed — try again.",
        });
        return;
      }
      if (data.policies === "ready" && data.shipFrom) {
        setFixNotice({ kind: "success", text: "eBay is ready to publish." });
        setChannels((prev) =>
          prev.map((ch) =>
            ch.platform === "ebay"
              ? {
                  ...ch,
                  ebayReadiness: {
                    ...ch.ebayReadiness,
                    shipFrom: true,
                    policies: "ready" as const,
                  },
                }
              : ch
          )
        );
      } else {
        setFixNotice({
          kind: "warn",
          text: data.message ?? "eBay setup needs one more step.",
          actionUrl: data.actionUrl,
        });
      }
    } catch {
      setFixNotice({ kind: "warn", text: "Connection failed — try again." });
    } finally {
      setFixing(false);
    }
  }

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
            Connect your channels once. eBay publishing is in beta; other channels are labeled by what they can do today.
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
                  <StatusBadge
                    status={
                      ch.needsReconnect
                        ? "expired"
                        : ch.connected
                          ? "connected"
                          : "not_connected"
                    }
                    label={
                      ch.needsReconnect
                        ? "Reconnect needed"
                        : ch.connected
                          ? "Connected"
                          : "Not connected"
                    }
                  />
                </div>

                {ch.connected && (
                  <p className="text-xs text-gray-400">
                    {ch.accountLabel && <>Account: {ch.accountLabel} · </>}
                    {ch.lastSyncedAt
                      ? `Sales last synced ${new Date(ch.lastSyncedAt).toLocaleString()}`
                      : "Sales not synced yet"}
                  </p>
                )}

                {ch.needsReconnect && (
                  <p className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-2.5 py-1.5">
                    This connection&apos;s access expired. Reconnect to keep
                    publishing and sale-sync working.
                  </p>
                )}

                {/* eBay publish-readiness checklist — what's missing BEFORE
                    the user burns an AI credit on a listing that can't post. */}
                {ch.platform === "ebay" && ch.connected && (
                  <ul className="flex flex-col gap-1.5 text-sm border-t border-gray-100 pt-2 mt-1">
                    <li className="flex items-center gap-2 text-gray-700">
                      <span aria-hidden className="text-green-600">✓</span>
                      Connected
                    </li>
                    <li className="flex items-center gap-2">
                      {ch.ebayReadiness?.shipFrom ? (
                        <>
                          <span aria-hidden className="text-green-600">✓</span>
                          <span className="text-gray-700">Ship-from location</span>
                          <Link
                            href="/settings/ship-from"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            edit
                          </Link>
                        </>
                      ) : (
                        <>
                          <span aria-hidden className="text-gray-300">○</span>
                          <Link
                            href="/settings/ship-from"
                            className="text-blue-600 hover:underline"
                          >
                            Add your ship-from location →
                          </Link>
                        </>
                      )}
                    </li>
                    <li className="flex flex-col gap-1">
                      <span className="flex items-center gap-2">
                        {ch.ebayReadiness?.policies === "ready" ? (
                          <>
                            <span aria-hidden className="text-green-600">✓</span>
                            <span className="text-gray-700">Business policies</span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden className="text-gray-300">○</span>
                            <span className="text-gray-700">Business policies</span>
                          </>
                        )}
                      </span>
                      {ch.ebayReadiness?.policies === "missing" && (
                        <span className="pl-6 flex flex-col gap-1.5">
                          <span className="text-xs text-gray-500">{EBAY_POLICY_HELP}</span>
                          {ch.ebayReadiness.proposedPolicies && (
                            <ul className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 space-y-0.5 list-disc pl-6">
                              <li>{ch.ebayReadiness.proposedPolicies.fulfillment}</li>
                              <li>{ch.ebayReadiness.proposedPolicies.payment}</li>
                              <li>{ch.ebayReadiness.proposedPolicies.returns}</li>
                            </ul>
                          )}
                          <button
                            onClick={() => void fixEbayReadiness()}
                            disabled={fixing}
                            className="self-start px-3 py-1.5 rounded-lg btn-primary font-medium text-xs disabled:opacity-50 transition-colors"
                          >
                            {fixing
                              ? "Creating…"
                              : "I approve — create these policies on my eBay account"}
                          </button>
                        </span>
                      )}
                      {ch.ebayReadiness?.policies === "not_registered" && (
                        <span className="pl-6 flex flex-col gap-1">
                          <span className="text-xs text-gray-500">
                            eBay needs you to finish seller registration
                            (identity and payout details) before it allows
                            selling policies — we can&apos;t do that part for
                            you.
                          </span>
                          <a
                            href={
                              ch.ebayReadiness.registrationUrl ??
                              "https://www.ebay.com/sl/sell"
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="self-start text-blue-600 hover:underline text-sm font-medium"
                          >
                            Finish your eBay seller setup →
                          </a>
                        </span>
                      )}
                      {ch.ebayReadiness?.policies === "unknown" && (
                        <span className="pl-6 text-xs text-gray-400">
                          Couldn&apos;t check right now — publishing will set
                          this up automatically if possible.
                        </span>
                      )}
                    </li>
                    {fixNotice && (
                      <li
                        role={fixNotice.kind === "success" ? "status" : "alert"}
                        className={`text-xs rounded-lg px-2.5 py-1.5 ${
                          fixNotice.kind === "success"
                            ? "text-green-800 bg-green-50 border border-green-100"
                            : "text-warn bg-warn-surface border border-amber-200"
                        }`}
                      >
                        {fixNotice.text}
                        {fixNotice.actionUrl && (
                          <>
                            {" "}
                            <a
                              href={fixNotice.actionUrl}
                              target={
                                fixNotice.actionUrl.startsWith("http")
                                  ? "_blank"
                                  : undefined
                              }
                              rel="noopener noreferrer"
                              className="underline font-medium"
                            >
                              Fix →
                            </a>
                          </>
                        )}
                      </li>
                    )}
                  </ul>
                )}

                {ch.platform === "ebay" && !ch.connected && (
                  <Link
                    href="/settings/ship-from"
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    Ship-from location →
                  </Link>
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
                      className="px-4 py-2 rounded-lg btn-primary font-medium text-sm transition-colors"
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
