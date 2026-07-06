"use client";

// Billing page: current plan, credits remaining, renewal date, and the
// Stripe Customer Portal for payment method / plan / invoices / cancellation.
// Signed-out visitors are bounced to /login by middleware.

import { useEffect, useState } from "react";
import Link from "next/link";

interface BillingStatus {
  plan: { key: string; name: string; monthlyCredits: number };
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  renewsAt: string | null;
  creditsRemaining: number | null;
  creditsGranted: number | null;
}

export default function BillingPage() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalBusy, setPortalBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkoutBanner, setCheckoutBanner] = useState(false);

  useEffect(() => {
    // Deferred so the effect body stays free of synchronous setState.
    const fromCheckout =
      new URLSearchParams(window.location.search).get("checkout") === "success";
    if (fromCheckout) queueMicrotask(() => setCheckoutBanner(true));
    void fetch("/api/billing/status")
      .then((res) => {
        if (res.status === 401) {
          window.location.assign("/login?next=/billing");
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: BillingStatus | null) => {
        if (data) setStatus(data);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function openPortal() {
    setError("");
    setPortalBusy(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not open the billing portal.");
        setPortalBusy(false);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("Connection failed. Please try again.");
      setPortalBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-lg flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        </div>

        {checkoutBanner && (
          <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
            Subscription active — your monthly credits are granted as soon as
            Stripe confirms the payment (usually seconds).
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : status ? (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Current plan</p>
                <p className="font-semibold text-gray-900">{status.plan.name}</p>
              </div>
              {status.subscriptionStatus === "past_due" && (
                <span className="text-xs font-medium text-red-600 bg-red-50 px-2 py-0.5 rounded">
                  Payment issue — update your card
                </span>
              )}
              {status.cancelAtPeriodEnd && (
                <span className="text-xs font-medium text-orange-600 bg-orange-50 px-2 py-0.5 rounded">
                  Cancels at period end
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-gray-500">AI credits left</p>
                <p className="font-semibold text-gray-900 text-lg">
                  {status.creditsRemaining ?? "—"}
                  {status.creditsGranted !== null && (
                    <span className="text-xs font-normal text-gray-400">
                      {" "}/ {status.creditsGranted}
                    </span>
                  )}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-gray-500">
                  {status.subscriptionStatus ? "Renews" : "Trial ends"}
                </p>
                <p className="font-semibold text-gray-900 text-lg">
                  {status.renewsAt
                    ? new Date(status.renewsAt).toLocaleDateString()
                    : "—"}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {status.subscriptionStatus ? (
                <button
                  onClick={() => void openPortal()}
                  disabled={portalBusy}
                  className="w-full py-3 rounded-xl btn-primary font-semibold text-sm disabled:opacity-50 transition-colors"
                >
                  {portalBusy
                    ? "Opening..."
                    : "Manage subscription (payment, invoices, cancel)"}
                </button>
              ) : (
                <Link
                  href="/pricing"
                  className="w-full py-3 rounded-xl btn-primary font-semibold text-sm text-center transition-colors"
                >
                  Choose a plan →
                </Link>
              )}
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500 text-center">
            Billing status is unavailable right now.
          </p>
        )}

        <Link href="/" className="text-sm text-blue-600 hover:underline text-center">
          ← Back to Snap to List
        </Link>
      </div>
    </main>
  );
}
