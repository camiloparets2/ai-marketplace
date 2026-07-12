"use client";

// eBay item specifics for the draft-edit view (docs: the sandbox blocker —
// publish was correctly guarded on required aspects, but there was NO UI to
// add them). Fetches the leaf category + aspect metadata at DRAFT time via
// /api/inventory/[id]/aspects, renders one field per REQUIRED aspect
// (closed enums as <select>, numbers as numeric input, everything else free
// text), recommended aspects as an optional section, and lets the seller
// swap the category — a wrong auto-leaf is what drags in silly requirements.
//
// The component owns fetching; the PARENT owns the specs record (it is also
// the save payload) and the publish gating, fed through onStatus.

import { useCallback, useEffect, useState } from "react";
import {
  EBAY_CATEGORY_SPEC_KEY,
  EBAY_CATEGORY_NAME_SPEC_KEY,
  aspectInputKind,
  aspectPlaceholder,
} from "@/lib/ebay-aspects";
import type { AspectField, CategoryOption } from "@/lib/ebay-aspects";

interface AspectsPayload {
  connected: boolean;
  categoryId: string | null;
  categoryName: string | null;
  suggestions: CategoryOption[];
  aspects: AspectField[];
  staleCategory: boolean;
}

export interface ItemSpecificsStatus {
  // null → requirements unknown (not connected / lookup failed): the parent
  // must NOT gate publish on it (the server-side guard is the backstop).
  aspects: AspectField[] | null;
}

export interface ItemSpecificsCardProps {
  itemId: string;
  // Brand/Model live in their own columns and become aspects at publish
  // time — the form counts them as present without duplicating them here.
  brand: string | null;
  model: string | null;
  specs: Record<string, string>;
  onSpecsChange: (next: Record<string, string>) => void;
  onStatus: (status: ItemSpecificsStatus) => void;
  editable: boolean;
}

// Case-insensitive spec lookup — extraction keys ("type") and eBay aspect
// names ("Type") must land on the same field, mirroring the publish guard.
function specValue(
  specs: Record<string, string>,
  brand: string | null,
  model: string | null,
  name: string
): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(specs)) {
    if (key.toLowerCase() === lower) return value;
  }
  if (lower === "brand") return brand ?? "";
  if (lower === "model") return model ?? "";
  return "";
}

function AspectInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: AspectField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const kind = aspectInputKind(field);
  const inputId = `aspect-${field.name.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-gray-600">
        {field.name}
        {field.required && <span className="text-red-500"> *</span>}
      </label>
      {kind === "select" ? (
        <select
          id={inputId}
          className="w-full rounded-(--radius-control) border border-gray-200 px-3 min-h-touch text-sm text-gray-900 bg-white"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={field.required}
        >
          <option value="">— select —</option>
          {/* keep a saved value visible even if eBay's list moved on */}
          {value !== "" && !field.values.includes(value) && (
            <option value={value}>{value}</option>
          )}
          {field.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type="text"
          inputMode={kind === "number" ? "decimal" : undefined}
          className="w-full rounded-(--radius-control) border border-gray-200 px-3 min-h-touch text-sm text-gray-900"
          placeholder={aspectPlaceholder(field)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={field.required}
        />
      )}
    </div>
  );
}

export function ItemSpecificsCard({
  itemId,
  brand,
  model,
  specs,
  onSpecsChange,
  onStatus,
  editable,
}: ItemSpecificsCardProps) {
  const [data, setData] = useState<AspectsPayload | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");

  const load = useCallback(
    async (categoryId?: string) => {
      setState("loading");
      try {
        const qs = categoryId ? `?category=${encodeURIComponent(categoryId)}` : "";
        const res = await fetch(`/api/inventory/${itemId}/aspects${qs}`);
        if (!res.ok) throw new Error(String(res.status));
        const payload = (await res.json()) as AspectsPayload;
        setData(payload);
        setState("done");
        onStatus({ aspects: payload.connected ? payload.aspects : null });
      } catch {
        setData(null);
        setState("error");
        onStatus({ aspects: null });
      }
    },
    [itemId, onStatus]
  );

  useEffect(() => {
    // Deferred so the effect body stays free of synchronous setState.
    queueMicrotask(() => void load(specs[EBAY_CATEGORY_SPEC_KEY]));
    // Initial load only — category changes refetch explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  function setAspect(name: string, value: string) {
    // Write under the eBay aspect name; drop a case-variant extraction key
    // so the value doesn't live under two spellings.
    const next: Record<string, string> = {};
    for (const [key, v] of Object.entries(specs)) {
      if (key.toLowerCase() !== name.toLowerCase()) next[key] = v;
    }
    if (value !== "") next[name] = value;
    onSpecsChange(next);
  }

  async function changeCategory(categoryId: string) {
    const name =
      data?.suggestions.find((s) => s.categoryId === categoryId)?.categoryName ??
      "";
    onSpecsChange({
      ...specs,
      [EBAY_CATEGORY_SPEC_KEY]: categoryId,
      ...(name ? { [EBAY_CATEGORY_NAME_SPEC_KEY]: name } : {}),
    });
    await load(categoryId);
  }

  if (state === "error") {
    return (
      <p className="text-xs text-gray-500">
        Couldn&apos;t load eBay&apos;s requirements for this item — you can
        still publish; anything missing is checked again at publish time.
      </p>
    );
  }
  if (state === "loading" && !data) {
    return <p className="text-xs text-gray-400">Checking eBay requirements…</p>;
  }
  if (!data) return null;

  if (!data.connected) {
    return (
      <p className="text-xs text-gray-500">
        Connect your eBay account to see which item specifics this category
        requires.
      </p>
    );
  }

  const required = data.aspects.filter((f) => f.required);
  const recommended = data.aspects.filter((f) => !f.required && f.recommended);
  const value = (name: string) => specValue(specs, brand, model, name);
  const missing = required.filter((f) => value(f.name).trim() === "");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">eBay item specifics</p>
        {state === "loading" && (
          <span className="text-xs text-gray-400">updating…</span>
        )}
      </div>

      {/* Category — a wrong leaf is what drags in irrelevant requirements */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="ebay-category"
          className="text-xs font-medium text-gray-600"
        >
          eBay category
        </label>
        <select
          id="ebay-category"
          className="w-full rounded-(--radius-control) border border-gray-200 px-3 min-h-touch text-sm text-gray-900 bg-white"
          value={data.categoryId ?? ""}
          onChange={(e) => void changeCategory(e.target.value)}
          disabled={!editable || data.suggestions.length === 0}
        >
          {data.categoryId !== null &&
            !data.suggestions.some((s) => s.categoryId === data.categoryId) && (
              <option value={data.categoryId}>
                {data.categoryName ?? `Category ${data.categoryId}`}
              </option>
            )}
          {data.suggestions.map((s) => (
            <option key={s.categoryId} value={s.categoryId}>
              {s.categoryName}
            </option>
          ))}
        </select>
        {data.staleCategory && (
          <p className="text-xs text-warn">
            The previously chosen category is no longer valid on eBay — pick
            one from the list.
          </p>
        )}
      </div>

      {required.length === 0 ? (
        <p className="text-xs text-gray-500">
          This category has no required item specifics. 🎉
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {required.map((f) => (
            <AspectInput
              key={f.name}
              field={f}
              value={value(f.name)}
              onChange={(v) => setAspect(f.name, v)}
              disabled={!editable}
            />
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <p
          role="alert"
          className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-3 py-2"
        >
          eBay requires {missing.map((f) => f.name).join(", ")} for this
          category — publishing is blocked until they&apos;re filled in.
        </p>
      )}

      {recommended.length > 0 && (
        <details className="group">
          <summary className="text-xs text-blue-600 cursor-pointer select-none">
            Optional details eBay recommends ({recommended.length}) — better
            search placement
          </summary>
          <div className="flex flex-col gap-2.5 mt-2.5">
            {recommended.map((f) => (
              <AspectInput
                key={f.name}
                field={f}
                value={value(f.name)}
                onChange={(v) => setAspect(f.name, v)}
                disabled={!editable}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
