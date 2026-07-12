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
  // Structured comps hints — better comp quality than title-only search.
  compsBrand?: string | null;
  compsCondition?: string | null;
  // One-line rationale for the AI-suggested price the field was pre-filled
  // with; null → no suggestion arrived (the field starts empty).
  aiRationale?: string | null;
}

export function PricingPanel({
  price,
  onPriceChange,
  costBasis,
  shippingCost,
  compsQuery,
  compsBrand = null,
  compsCondition = null,
  aiRationale = null,
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
      const params = new URLSearchParams({ q: compsQuery });
      if (compsBrand?.trim()) params.set("brand", compsBrand.trim());
      if (compsCondition?.trim()) params.set("condition", compsCondition.trim());
      void fetch(`/api/comps?${params.toString()}`)
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
  }, [compsQuery, compsBrand, compsCondition]);

  // null → no shipping estimate → NO floor exists (never treated as $0 ship).
  const floor = computeFloor(costBasis, shippingCost);
  const priceNum = parseFloat(price);
  const hasPrice = !isNaN(priceNum) && priceNum > 0;
  const belowFloor = hasPrice && floor !== null && priceNum < floor;
  // Anchor reference: sold median when granted, active-asking median otherwise.
  const median = comps?.medianPrice ?? null;
  // A reference below the floor means the market won't clear a profitable price.
  const marketBelowFloor = median !== null && floor !== null && median < floor;
  const hasBand =
    comps !== null && comps.lowPrice !== null && comps.highPrice !== null;

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

      {/* AI suggestion rationale — why the field was pre-filled */}
      {aiRationale && (
        <p className="text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
          <span className="font-semibold">AI suggestion:</span> {aiRationale}{" "}
          <span className="text-blue-600">Edit the price as you like.</span>
        </p>
      )}

      {/* Floor indicator. Missing shipping means NO floor at all (the money
          rule: unknown shipping is never $0); missing cost shows the partial
          floor with a caveat. */}
      {floor === null ? (
        <div
          id="price-floor"
          role="alert"
          className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-3 py-2"
        >
          ⚠ We couldn&apos;t estimate shipping for this item — enter a shipping
          cost or pick a service. Without it there is no break-even floor and
          the item can&apos;t publish.
        </div>
      ) : (
        <p id="price-floor" className="text-xs text-gray-500">
          {costBasis === null ? (
            <>
              Break-even floor unknown — without your item cost it&apos;s at least{" "}
              <span className="font-semibold text-gray-700">${floor.toFixed(2)}</span>{" "}
              (fees {Math.round(PRICING_DEFAULTS.feeRate * 100)}% incl. on shipping +
              minimum margin; the buyer pays shipping at checkout). Add your
              cost for the real floor.
            </>
          ) : (
            <>
              Break-even floor <span className="font-semibold text-gray-700">${floor.toFixed(2)}</span>{" "}
              — cost + fees ({Math.round(PRICING_DEFAULTS.feeRate * 100)}%, incl. on shipping) +
              minimum margin. The buyer pays shipping at checkout.
            </>
          )}
        </p>
      )}

      {/* Comps snapshot */}
      {compsState === "loading" && (
        <p className="text-xs text-gray-400">Checking recent sales…</p>
      )}
      {compsState === "done" && comps && hasBand && (
        <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span>
            Similar items:{" "}
            <span className="font-semibold text-gray-800">
              ${comps.lowPrice?.toFixed(2)}–${comps.highPrice?.toFixed(2)}
            </span>{" "}
            <span className="text-gray-400">
              ({comps.sampleSize} {comps.source === "sold" ? "sold" : "active"})
            </span>{" "}
            · demand: {comps.demandSignal}
          </span>
          {median !== null && (
            <span className="text-gray-500">
              {comps.source === "sold" ? "Sold median" : "Asking median"} $
              {median.toFixed(2)}
              {comps.confidence === "low" ? " · sparse data — double-check" : ""}
            </span>
          )}
          {comps.source === "active" && (
            <span className="text-gray-400">
              Based on current asking prices, not completed sales.
            </span>
          )}
        </div>
      )}
      {compsState === "done" && !hasBand && (
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
