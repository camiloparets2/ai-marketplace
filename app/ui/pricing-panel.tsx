"use client";

// PricingPanel — the seller's price with the floor, comps snapshot, and a
// clear "unprofitable" warning when the price can't cover the floor. Reuses
// the SAME pure math the server pricing engine uses (lib/pricing-core), so
// the browser floor and the server floor never disagree.

import { useEffect, useState } from "react";
import { computeFloor, PRICING_DEFAULTS } from "@/lib/pricing-core";
import type { CompsSummary } from "@/lib/comps";

export interface PricingPanelProps {
  // controlled price string (parent owns it — it's also the publish input)
  price: string;
  onPriceChange: (value: string) => void;
  // cost basis + shipping feed the floor; null → floor assumes $0 for that term
  costBasis: number | null;
  shippingCost: number | null;
  // query for the comps lookup (usually the listing title)
  compsQuery: string;
}

export function PricingPanel({
  price,
  onPriceChange,
  costBasis,
  shippingCost,
  compsQuery,
}: PricingPanelProps) {
  const [comps, setComps] = useState<CompsSummary | null>(null);
  const [compsState, setCompsState] = useState<"idle" | "loading" | "done">(
    "idle"
  );

  useEffect(() => {
    if (!compsQuery.trim()) return;
    let cancelled = false;
    // Deferred so the effect body stays free of synchronous setState
    // (Next 16 react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      if (cancelled) return;
      setCompsState("loading");
      void fetch(`/api/comps?q=${encodeURIComponent(compsQuery)}`)
        .then((res) => (res.ok ? res.json() : { comps: null }))
        .then((data: { comps?: CompsSummary | null }) => {
          if (cancelled) return;
          setComps(data.comps ?? null);
          setCompsState("done");
        })
        .catch(() => {
          if (cancelled) return;
          setComps(null);
          setCompsState("done");
        });
    });
    return () => {
      cancelled = true;
    };
  }, [compsQuery]);

  const floor = computeFloor(costBasis, shippingCost);
  const priceNum = parseFloat(price);
  const hasPrice = !isNaN(priceNum) && priceNum > 0;
  const belowFloor = hasPrice && priceNum < floor;
  const median = comps?.medianSoldPrice ?? null;
  // A reference below the floor means the market won't clear a profitable price.
  const marketBelowFloor = median !== null && median < floor;

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="price" className="text-sm font-medium text-gray-700">
        Your asking price
      </label>

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
          $
        </span>
        <input
          id="price"
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          className={`w-full rounded-(--radius-control) border pl-7 pr-3 min-h-touch text-lg font-semibold text-gray-900 ${
            belowFloor ? "border-red-400" : "border-gray-200"
          }`}
          placeholder="0.00"
          value={price}
          onChange={(e) => onPriceChange(e.target.value)}
          aria-invalid={belowFloor || undefined}
          aria-describedby="price-floor"
        />
      </div>

      {/* Floor indicator */}
      <p id="price-floor" className="text-xs text-gray-500">
        Break-even floor <span className="font-semibold text-gray-700">${floor.toFixed(2)}</span>{" "}
        — cost + fees ({Math.round(PRICING_DEFAULTS.feeRate * 100)}%) + shipping + minimum margin.
        {costBasis === null && " Add your cost for an accurate floor."}
      </p>

      {/* Comps snapshot */}
      {compsState === "loading" && (
        <p className="text-xs text-gray-400">Checking recent sales…</p>
      )}
      {compsState === "done" && comps && median !== null && (
        <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span>
            Recent sold median{" "}
            <span className="font-semibold text-gray-800">${median.toFixed(2)}</span>{" "}
            <span className="text-gray-400">({comps.soldCount} sold{comps.confidence === "low" ? ", sparse" : ""})</span>
          </span>
          {comps.activeCount !== null && (
            <span className="text-gray-500">
              {comps.activeCount} active listing{comps.activeCount === 1 ? "" : "s"}
              {comps.medianActivePrice !== null &&
                ` asking ~$${comps.medianActivePrice.toFixed(2)} median`}
            </span>
          )}
        </div>
      )}
      {compsState === "done" && !comps && (
        <p className="text-xs text-gray-400">
          No comparable sales found — priced conservatively; double-check the market.
        </p>
      )}

      {/* Warning states */}
      {belowFloor && (
        <div
          role="alert"
          className="text-xs text-danger bg-danger-surface border border-red-200 rounded-lg px-3 py-2"
        >
          ⚠ ${priceNum.toFixed(2)} is below your ${floor.toFixed(2)} break-even floor — you&apos;d
          lose money on this sale. Raise the price or skip it.
        </div>
      )}
      {!belowFloor && marketBelowFloor && (
        <div
          role="alert"
          className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-3 py-2"
        >
          ⚠ The market median (${median.toFixed(2)}) is under your ${floor.toFixed(2)} floor.
          This item may not sell profitably — consider skipping it.
        </div>
      )}
    </div>
  );
}
