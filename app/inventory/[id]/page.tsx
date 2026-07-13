"use client";

// Item detail & edit — the view every draft was missing: fix the title,
// price, condition, shipping cost, and cost basis, then publish (or retry a
// failed publish) WITHOUT re-running AI or spending a credit. Also the
// landing spot for "Finish N drafts" and the failure CTA on draft cards.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/app/ui/button";
import { Card } from "@/app/ui/card";
import { StatusBadge } from "@/app/ui/status-badge";
import { PricingPanel } from "@/app/ui/pricing-panel";
import { ItemSpecificsCard } from "@/app/ui/item-specifics";
import type { ItemSpecificsStatus } from "@/app/ui/item-specifics";
import { useToast } from "@/app/ui/toast";
import { getAllFlatRates } from "@/lib/shipping";
import {
  missingRequiredAspectValues,
  EBAY_CATEGORY_SPEC_KEY,
  EBAY_CATEGORY_NAME_SPEC_KEY,
} from "@/lib/ebay-aspects";
import type { AspectField } from "@/lib/ebay-aspects";
import { nearestAllowedConditionId } from "@/lib/ebay-conditions";
import type { ConditionGrade } from "@/lib/ebay-conditions";

interface ItemDetail {
  id: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: string;
  category: string | null;
  specs: Record<string, string> | null;
  photo_url: string | null;
  price: number | null;
  cost_of_goods: number | null;
  shipping_cost: number | null;
  status: "draft" | "review" | "listed" | "sold" | "archived";
  review_reasons: Array<{ gate: string; reason: string }>;
}

type PublishOutcome =
  | { status: "live"; url: string }
  | { status: "dry_run" }
  | { status: "not_connected"; connectUrl: string }
  | { status: "error"; message: string };

const CONDITIONS = ["New", "Like New", "Very Good", "Good", "Acceptable"];

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const [item, setItem] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>("");

  // Edit state (strings — they're form fields)
  const [title, setTitle] = useState("");
  const [condition, setCondition] = useState("Good");
  const [price, setPrice] = useState("");
  const [shipCost, setShipCost] = useState("");
  const [costBasis, setCostBasis] = useState("");
  // eBay item specifics + the reserved __ebayCategoryId key — saved with the
  // draft so republish/retry reuses them (no re-analyze, no credit).
  const [specs, setSpecs] = useState<Record<string, string>>({});
  // Required-aspect metadata from /aspects; null → unknown (don't gate here,
  // the publish-time guard is the backstop).
  const [aspectFields, setAspectFields] = useState<AspectField[] | null>(null);
  // Condition ids the resolved category legally accepts; null → unknown
  // (never constrain the dropdown on missing metadata).
  const [allowedConditionIds, setAllowedConditionIds] = useState<
    string[] | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);

  const applyItem = useCallback((it: ItemDetail) => {
    setItem(it);
    setTitle(it.title);
    setCondition(it.condition);
    setPrice(it.price !== null ? String(it.price) : "");
    // MONEY RULE: a stored $0 shipping cost is never trusted as a default —
    // it means free shipping the seller silently absorbs (the concrete-bag
    // bug). Open the field EMPTY so publishing stays blocked until the
    // seller deliberately types a cost (0 included — but typed, not
    // defaulted).
    setShipCost(
      it.shipping_cost !== null && it.shipping_cost > 0
        ? String(it.shipping_cost)
        : ""
    );
    setCostBasis(it.cost_of_goods !== null ? String(it.cost_of_goods) : "");
    setSpecs(it.specs ?? {});
  }, []);

  const onAspectStatus = useCallback((status: ItemSpecificsStatus) => {
    setAspectFields(status.aspects);
    setAllowedConditionIds(status.allowedConditionIds);
    // Mirror the ONE resolved category into the client specs (functional
    // update — this fires from the card's fetch) so Save never wipes the
    // server-side pin and the breadcrumb below shows the same answer as the
    // dropdown and the publish step.
    if (status.categoryId !== null) {
      const id = status.categoryId;
      const name = status.categoryName;
      setSpecs((prev) =>
        prev[EBAY_CATEGORY_SPEC_KEY] === id &&
        (name === null || prev[EBAY_CATEGORY_NAME_SPEC_KEY] === name)
          ? prev
          : {
              ...prev,
              [EBAY_CATEGORY_SPEC_KEY]: id,
              ...(name ? { [EBAY_CATEGORY_NAME_SPEC_KEY]: name } : {}),
            }
      );
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetch(`/api/inventory/${id}`)
        .then(async (res) => {
          if (res.status === 401) {
            window.location.assign(`/login?next=/inventory/${id}`);
            return;
          }
          const data = (await res.json()) as { item?: ItemDetail; error?: string };
          if (!res.ok || !data.item) {
            setLoadError(data.error ?? "Could not load the item.");
          } else {
            applyItem(data.item);
          }
        })
        .catch(() => setLoadError("Connection failed. Please try again."))
        .finally(() => setLoading(false));
    });
  }, [id, applyItem]);

  const editable = item?.status === "draft" || item?.status === "review";
  const priceNum = parseFloat(price);
  const shipNum = shipCost.trim() === "" ? null : parseFloat(shipCost);
  const costNum = costBasis.trim() === "" ? null : parseFloat(costBasis);
  const shipValid = shipNum === null || (isFinite(shipNum) && shipNum >= 0);
  const costValid = costNum === null || (isFinite(costNum) && costNum >= 0);
  const priceValid = isFinite(priceNum) && priceNum > 0;
  // eBay-required item specifics still empty (Brand/Model count via their
  // own columns). Unknown requirements ([] when aspectFields is null) never
  // block here — the server-side publish guard is the backstop.
  const missingAspects =
    aspectFields !== null && item?.status === "draft"
      ? missingRequiredAspectValues(aspectFields, {
          Brand: item?.brand ?? "",
          Model: item?.model ?? "",
          ...specs,
        })
      : [];
  // Category condition policy (same layer as the publish step): the selected
  // grade must map to a condition the category accepts. Unknown policy
  // (null) never blocks — the server-side guard is the backstop.
  const conditionIllegal =
    allowedConditionIds !== null &&
    nearestAllowedConditionId(condition as ConditionGrade, allowedConditionIds) ===
      null;

  async function save(): Promise<boolean> {
    if (!item) return false;
    if (!title.trim()) {
      toast.error("Title cannot be empty");
      return false;
    }
    if (!priceValid || !shipValid || !costValid) {
      toast.error("Check the price, shipping, and cost fields");
      return false;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/inventory/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          condition,
          price: priceNum,
          shippingCost: shipNum,
          costOfGoods: costNum,
          specs,
        }),
      });
      const data = (await res.json()) as { item?: ItemDetail; error?: string };
      if (!res.ok || !data.item) {
        toast.error(data.error ?? "Save failed");
        return false;
      }
      applyItem(data.item);
      return true;
    } catch {
      toast.error("Connection failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveOnly() {
    if (await save()) toast.success("Saved");
  }

  // Save first (the publish uses the STORED row), then publish.
  async function publish() {
    if (!item) return;
    setOutcome(null);
    if (!(await save())) return;
    setPublishing(true);
    try {
      const res = await fetch(`/api/inventory/${item.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish" }),
      });
      const data = (await res.json()) as {
        publish?: PublishOutcome;
        error?: string;
      };
      if (!res.ok || !data.publish) {
        setOutcome({ status: "error", message: data.error ?? "Publish failed" });
        return;
      }
      setOutcome(data.publish);
      if (data.publish.status === "live") {
        toast.success("Listed!");
        // Refresh — the item just left draft.
        const detail = await fetch(`/api/inventory/${item.id}`);
        const refreshed = (await detail.json()) as { item?: ItemDetail };
        if (refreshed.item) applyItem(refreshed.item);
      }
    } catch {
      setOutcome({ status: "error", message: "Connection failed. Please try again." });
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6 pb-24">
      <div className="w-full max-w-lg mx-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Link href="/inventory" className="text-sm text-blue-600 hover:underline">
            ← Inventory
          </Link>
          {item && <StatusBadge status={item.status} />}
        </div>

        {loading ? (
          <Card>
            <div className="h-40 animate-pulse bg-gray-100 rounded-lg" />
          </Card>
        ) : loadError || !item ? (
          <Card>
            <p className="text-sm text-gray-600">{loadError || "Item not found."}</p>
          </Card>
        ) : (
          <>
            <Card className="flex flex-col gap-4">
              <div className="flex gap-3">
                {item.photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.photo_url}
                    alt={item.title}
                    className="w-24 h-24 object-cover rounded-lg flex-shrink-0"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-lg bg-gray-100 flex-shrink-0 flex items-center justify-center text-xs text-gray-400">
                    no photo
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  {/* ONE category answer: the resolved eBay leaf (same as the
                      specifics dropdown + what publish uses); the AI's guess
                      only until resolution arrives. */}
                  {(specs[EBAY_CATEGORY_NAME_SPEC_KEY] ?? item.category) && (
                    <p className="text-xs text-gray-400">
                      {specs[EBAY_CATEGORY_NAME_SPEC_KEY] ?? item.category}
                    </p>
                  )}
                  <p className="text-sm text-gray-500 mt-1">
                    {editable
                      ? "Edit the listing, then publish."
                      : "This item is no longer editable here."}
                  </p>
                </div>
              </div>

              <label className="text-sm font-medium text-gray-700" htmlFor="title">
                Title
              </label>
              <input
                id="title"
                type="text"
                className="w-full rounded-(--radius-control) border border-gray-200 px-3 min-h-touch text-sm text-gray-900"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!editable}
              />

              <label className="text-sm font-medium text-gray-700" htmlFor="condition">
                Condition
              </label>
              <select
                id="condition"
                className="w-full rounded-(--radius-control) border border-gray-200 px-3 min-h-touch text-sm text-gray-900 bg-white"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                disabled={!editable}
              >
                {/* Grades the resolved eBay category can't legally take are
                    disabled (category condition policy) — the seller can
                    never pick a condition eBay would 400. */}
                {CONDITIONS.map((c) => {
                  const illegal =
                    allowedConditionIds !== null &&
                    nearestAllowedConditionId(
                      c as ConditionGrade,
                      allowedConditionIds
                    ) === null;
                  return (
                    <option key={c} value={c} disabled={illegal}>
                      {c}
                      {illegal ? " — not allowed in this eBay category" : ""}
                    </option>
                  );
                })}
              </select>
              {conditionIllegal && (
                <p
                  role="alert"
                  className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-3 py-2"
                >
                  {`This eBay category doesn't accept the "${condition}" condition — pick an allowed one (or change the category below). Publishing is blocked until then.`}
                </p>
              )}

              {/* Shipping — the money rule: no cost, no publish */}
              <label className="text-sm font-medium text-gray-700" htmlFor="ship">
                Shipping cost
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  $
                </span>
                <input
                  id="ship"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full rounded-(--radius-control) border border-gray-200 pl-7 pr-3 min-h-touch text-sm text-gray-900"
                  placeholder="e.g. 16.10"
                  value={shipCost}
                  onChange={(e) => setShipCost(e.target.value)}
                  disabled={!editable}
                />
              </div>
              {editable && (
                <div className="flex flex-wrap gap-1.5 -mt-1">
                  {getAllFlatRates().map((r) =>
                    r.cost !== null ? (
                      <button
                        key={r.service}
                        type="button"
                        onClick={() => setShipCost(String(r.cost))}
                        className="text-xs px-2 py-1 rounded-badge border border-gray-200 text-gray-600 bg-white hover:bg-gray-50"
                      >
                        {r.displayName} · ${r.cost.toFixed(2)}
                      </button>
                    ) : null
                  )}
                </div>
              )}
              {shipNum === null && editable && (
                <p className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-3 py-2">
                  ⚠ We couldn&apos;t estimate shipping for this item — enter a
                  shipping cost or pick a service. It can&apos;t publish without
                  one.
                </p>
              )}

              {/* Cost basis */}
              <label className="text-sm font-medium text-gray-700" htmlFor="cost">
                Your item cost (optional)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  $
                </span>
                <input
                  id="cost"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full rounded-(--radius-control) border border-gray-200 pl-7 pr-3 min-h-touch text-sm text-gray-900"
                  placeholder="what you paid"
                  value={costBasis}
                  onChange={(e) => setCostBasis(e.target.value)}
                  disabled={!editable}
                />
              </div>

              {/* Price + floor + comps (same math as the server) */}
              <PricingPanel
                price={price}
                onPriceChange={editable ? setPrice : () => undefined}
                costBasis={costValid ? costNum : null}
                shippingCost={shipValid ? shipNum : null}
                compsQuery={title}
                compsCondition={condition}
              />
            </Card>

            {/* eBay category + required/recommended item specifics — resolved
                at DRAFT time so the seller never dead-ends at publish. */}
            <Card className="flex flex-col gap-3">
              <ItemSpecificsCard
                itemId={item.id}
                title={title}
                brand={item.brand}
                model={item.model}
                specs={specs}
                onSpecsChange={setSpecs}
                onStatus={onAspectStatus}
                editable={editable}
              />
            </Card>

            {/* Why it's held (review items) */}
            {item.status === "review" && (
              <Card className="flex flex-col gap-2">
                <p className="text-xs font-medium text-amber-800">
                  Held for review — approve it from the{" "}
                  <Link href="/review" className="underline">
                    review queue
                  </Link>{" "}
                  after fixing the fields here:
                </p>
                <ul className="text-xs text-amber-700 list-disc pl-4 space-y-0.5">
                  {(item.review_reasons ?? []).map((r) => (
                    <li key={r.gate}>{r.reason}</li>
                  ))}
                </ul>
              </Card>
            )}

            {/* Publish outcome */}
            {outcome && outcome.status === "live" && (
              <div
                role="status"
                className="text-sm text-green-800 bg-green-50 border border-green-100 rounded-lg px-3 py-2"
              >
                Listed!{" "}
                <a
                  href={outcome.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium"
                >
                  View the live listing →
                </a>
              </div>
            )}
            {outcome && outcome.status === "not_connected" && (
              <div
                role="alert"
                className="text-sm text-warn bg-warn-surface border border-amber-200 rounded-lg px-3 py-2"
              >
                Connect your eBay account to publish.{" "}
                <a href={outcome.connectUrl} className="underline font-medium">
                  Connect →
                </a>
              </div>
            )}
            {outcome && outcome.status === "error" && (
              <div
                role="alert"
                className="text-sm text-danger bg-danger-surface border border-red-200 rounded-lg px-3 py-2"
              >
                {outcome.message}
              </div>
            )}

            {editable && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  loading={saving && !publishing}
                  onClick={() => void saveOnly()}
                >
                  Save
                </Button>
                {item.status === "draft" && (
                  <Button
                    className="flex-1"
                    loading={publishing}
                    disabled={
                      !priceValid ||
                      shipNum === null ||
                      !shipValid ||
                      missingAspects.length > 0 ||
                      conditionIllegal
                    }
                    onClick={() => void publish()}
                  >
                    List it
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
