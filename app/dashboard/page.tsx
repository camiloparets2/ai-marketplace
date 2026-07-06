"use client";

// Dashboard command center — the daily-driver view (roadmap "Professional UX
// Requirements"): credits, channel health, money snapshot, what needs
// attention, and the next best action. Signed-out visitors are bounced to
// /login by middleware.

import { useEffect, useState } from "react";
import Link from "next/link";

interface DashboardData {
  connections: { ebay: boolean; etsy: boolean };
  creditsRemaining: number | null;
  creditsRenewAt: string | null;
  items: { draft: number; listed: number; sold: number; archived: number };
  listedValue: number;
  soldValue: number;
  knownProfit: number;
  soldWithCostCount: number;
  soldCount: number;
  endFailedCount: number;
}

function Tile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "warn";
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p
        className={`text-xl font-bold mt-0.5 ${
          tone === "good"
            ? "text-green-700"
            : tone === "warn"
              ? "text-orange-600"
              : "text-gray-900"
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// The single most valuable thing to do right now, given current state.
function nextBestAction(d: DashboardData): { text: string; href: string } {
  if (d.endFailedCount > 0) {
    return {
      text: `Fix ${d.endFailedCount} listing${d.endFailedCount === 1 ? "" : "s"} that failed to delist — oversell risk`,
      href: "/inventory",
    };
  }
  if (!d.connections.ebay) {
    return { text: "Connect your eBay account to publish live", href: "/api/oauth/ebay/start" };
  }
  if (d.creditsRemaining === 0) {
    return { text: "You're out of AI credits — upgrade to keep listing", href: "/pricing" };
  }
  if (d.items.draft > 0) {
    return {
      text: `Finish ${d.items.draft} draft${d.items.draft === 1 ? "" : "s"} waiting in inventory`,
      href: "/inventory",
    };
  }
  return { text: "List your next item — snap a photo", href: "/" };
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("/api/dashboard")
      .then((res) => {
        if (res.status === 401) {
          window.location.assign("/login?next=/dashboard");
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((d: DashboardData | null) => {
        if (d) setData(d);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !data ? (
          <p className="text-sm text-gray-500 text-center">
            Dashboard is unavailable right now.
          </p>
        ) : (
          <>
            {/* Next best action */}
            <Link
              href={nextBestAction(data).href}
              className="block bg-blue-600 text-white rounded-2xl shadow-sm p-4 hover:bg-blue-700 transition-colors"
            >
              <p className="text-xs opacity-80">Next best action</p>
              <p className="font-semibold text-sm mt-0.5">
                {nextBestAction(data).text} →
              </p>
            </Link>

            {/* Attention */}
            {data.endFailedCount > 0 && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                ⚠ {data.endFailedCount} listing
                {data.endFailedCount === 1 ? "" : "s"} could not be delisted —
                retry from{" "}
                <Link href="/inventory" className="underline">
                  inventory
                </Link>{" "}
                before they oversell.
              </p>
            )}

            {/* Money */}
            <div className="grid grid-cols-2 gap-3">
              <Tile
                label="Live inventory value"
                value={`$${data.listedValue.toFixed(2)}`}
                sub={`${data.items.listed} listed item${data.items.listed === 1 ? "" : "s"}`}
              />
              <Tile
                label="Sales to date"
                value={`$${data.soldValue.toFixed(2)}`}
                sub={`${data.soldCount} sold`}
                tone="good"
              />
              <Tile
                label="Profit (tracked)"
                value={`$${data.knownProfit.toFixed(2)}`}
                sub={
                  data.soldCount > 0
                    ? `cost known for ${data.soldWithCostCount}/${data.soldCount} sales`
                    : "add cost of goods to track margin"
                }
                tone={data.knownProfit >= 0 ? "good" : "warn"}
              />
              <Tile
                label="AI credits"
                value={data.creditsRemaining !== null ? String(data.creditsRemaining) : "—"}
                sub={
                  data.creditsRenewAt
                    ? `renews ${new Date(data.creditsRenewAt).toLocaleDateString()}`
                    : undefined
                }
                tone={data.creditsRemaining === 0 ? "warn" : "default"}
              />
            </div>

            {/* Channels */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2">
              <p className="text-sm font-medium text-gray-700">Channels</p>
              {(["ebay", "etsy"] as const).map((p) => (
                <div key={p} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{p === "ebay" ? "eBay" : "Etsy"}</span>
                  {data.connections[p] ? (
                    <span className="text-green-600 font-medium">✓ Connected</span>
                  ) : (
                    <a
                      href={`/api/oauth/${p}/start`}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      Connect →
                    </a>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Facebook / OfferUp</span>
                <span className="text-purple-600 text-xs font-medium">
                  assisted at publish
                </span>
              </div>
            </div>

            {/* Quick links */}
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <Link
                href="/"
                className="py-2.5 rounded-xl bg-white border border-gray-100 shadow-sm text-gray-700 font-medium hover:bg-gray-50"
              >
                + List item
              </Link>
              <Link
                href="/inventory"
                className="py-2.5 rounded-xl bg-white border border-gray-100 shadow-sm text-gray-700 font-medium hover:bg-gray-50"
              >
                Inventory
              </Link>
              <Link
                href="/billing"
                className="py-2.5 rounded-xl bg-white border border-gray-100 shadow-sm text-gray-700 font-medium hover:bg-gray-50"
              >
                Billing
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
