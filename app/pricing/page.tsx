"use client";

// Public pricing page (roadmap Gate 4: "Pricing page clearly explains plan
// limits, AI credits, and renewal behavior"). Prices come from
// lib/billing/plans.ts — placeholders until final pricing is decided.

import { useState } from "react";
import Link from "next/link";
import { PLANS, PAID_PLAN_KEYS, TRIAL_CREDITS } from "@/lib/billing/plans";
import type { PlanKey } from "@/lib/billing/plans";

export default function PricingPage() {
  const [busyPlan, setBusyPlan] = useState<PlanKey | null>(null);
  const [error, setError] = useState("");

  async function subscribe(plan: PlanKey) {
    setError("");
    setBusyPlan(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (res.status === 401) {
        window.location.assign("/login?next=/pricing");
        return;
      }
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not start checkout. Please try again.");
        setBusyPlan(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("Connection failed. Please try again.");
      setBusyPlan(null);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-3xl flex flex-col gap-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Plans</h1>
          <p className="text-sm text-gray-500 mt-1">
            1 credit = 1 AI listing draft from a photo. Credits renew monthly
            with your subscription and don&apos;t roll over. Editing,
            publishing, and syncing never cost credits.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 text-center">
            {error}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Free trial card — granted automatically at sign-up */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-2">
            <p className="font-semibold text-gray-900">{PLANS.free_trial.name}</p>
            <p className="text-2xl font-bold text-gray-900">
              $0
              <span className="text-sm font-normal text-gray-400"> one time</span>
            </p>
            <p className="text-sm text-gray-500">{PLANS.free_trial.blurb}</p>
            <p className="text-sm text-gray-700 mt-auto pt-2">
              {TRIAL_CREDITS} AI drafts · included at sign-up
            </p>
            <Link
              href="/login"
              className="w-full py-2.5 rounded-xl border border-gray-200 text-gray-700 font-medium text-sm text-center hover:bg-gray-50 transition-colors"
            >
              Start free
            </Link>
          </div>

          {PAID_PLAN_KEYS.map((key) => {
            const plan = PLANS[key];
            const highlight = key === "pro";
            return (
              <div
                key={key}
                className={`bg-white rounded-2xl border shadow-sm p-5 flex flex-col gap-2 ${
                  highlight ? "border-blue-300 ring-1 ring-blue-200" : "border-gray-100"
                }`}
              >
                <p className="font-semibold text-gray-900 flex items-center gap-2">
                  {plan.name}
                  {highlight && (
                    <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                      most popular
                    </span>
                  )}
                </p>
                <p className="text-2xl font-bold text-gray-900">
                  ${plan.priceUsd}
                  <span className="text-sm font-normal text-gray-400">/month</span>
                </p>
                <p className="text-sm text-gray-500">{plan.blurb}</p>
                <p className="text-sm text-gray-700 mt-auto pt-2">
                  {plan.monthlyCredits.toLocaleString()} AI drafts / month ·
                  eBay, Etsy, assisted posting, direct checkout
                </p>
                <button
                  onClick={() => void subscribe(key)}
                  disabled={busyPlan !== null}
                  className={`w-full py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50 ${
                    highlight
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : "border border-gray-200 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {busyPlan === key ? "Opening checkout..." : "Subscribe"}
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-gray-400 text-center">
          Cancel anytime from the billing portal — access continues until the
          period ends. Out of credits? Your drafts, inventory, and connections
          stay fully accessible; only new AI drafts pause until renewal or
          upgrade.
        </p>

        <Link href="/" className="text-sm text-blue-600 hover:underline text-center">
          ← Back to Snap to List
        </Link>
      </div>
    </main>
  );
}
