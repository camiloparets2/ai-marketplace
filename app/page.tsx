"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Plus } from "lucide-react";
import type { ExtractionResult } from "@/lib/types/extraction";
import {
  CONFIDENCE_THRESHOLD,
  CRITICAL_FIELDS,
  SHIPPING_DISPLAY_NAMES,
} from "@/lib/types/extraction";
import { getAllFlatRates } from "@/lib/shipping";
import { prepareImageForUpload } from "@/lib/image-validation";
import { createClient } from "@/utils/supabase/client";
import { usePostHog } from "posthog-js/react";

// ─── Stage machine ────────────────────────────────────────────────────────────

type Stage =
  | "idle"       // condition selection + photo upload
  | "preparing"  // HEIC conversion + compression (client-side)
  | "analyzing"  // API call in flight
  | "review"     // extraction result, editable
  | "generating" // Stripe link creation
  | "done"       // link ready
  | "error";     // terminal error

// ─── Condition options ────────────────────────────────────────────────────────

const CONDITIONS: ExtractionResult["condition"][] = [
  "New",
  "Like New",
  "Good",
  "Fair",
  "Poor",
];

const CONDITION_COLORS: Record<string, string> = {
  New: "bg-green-100 text-green-700 border-green-300",
  "Like New": "bg-blue-100 text-blue-700 border-blue-300",
  Good: "bg-yellow-100 text-yellow-700 border-yellow-300",
  Fair: "bg-orange-100 text-orange-700 border-orange-300",
  Poor: "bg-red-100 text-red-700 border-red-300",
};

// ─── Loading progress stages ──────────────────────────────────────────────────

const ANALYSIS_STAGES = [
  { text: "Analyzing photos...", ms: 2_000 },
  { text: "Identifying specs...", ms: 5_000 },
  { text: "Researching market price...", ms: 9_000 },
  { text: "Almost there...", ms: Infinity },
];

function useLoadingStage(active: boolean) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const stage = ANALYSIS_STAGES[index];
    if (stage.ms === Infinity) return;
    const id = setTimeout(() => setIndex((i) => i + 1), stage.ms);
    return () => clearTimeout(id);
  }, [active, index]);

  return ANALYSIS_STAGES[Math.min(index, ANALYSIS_STAGES.length - 1)].text;
}

// ─── Confidence indicator ─────────────────────────────────────────────────────

function NeedsReview({
  field,
  confidence,
}: {
  field: keyof Omit<ExtractionResult, "confidence">;
  confidence: ExtractionResult["confidence"];
}) {
  const score = confidence[field];
  if (score === undefined || score >= CONFIDENCE_THRESHOLD) return null;
  const isCritical = (CRITICAL_FIELDS as readonly string[]).includes(field);
  return (
    <span
      className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded ${
        isCritical
          ? "bg-orange-100 text-orange-700"
          : "bg-yellow-100 text-yellow-700"
      }`}
    >
      ⚠ review
    </span>
  );
}

// ─── Editable field wrapper ───────────────────────────────────────────────────

function Field({
  label,
  indicator,
  children,
}: {
  label: string;
  indicator?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-600 flex items-center">
        {label}
        {indicator}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const router = useRouter();
  const posthog = usePostHog();
  const [authChecked, setAuthChecked] = useState(false);

  // ── Auth gate ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace("/login");
      } else {
        setAuthChecked(true);
      }
    });
  }, [router]);

  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string>("");

  // Phase 3: condition-first + multi-image state
  const [selectedCondition, setSelectedCondition] =
    useState<ExtractionResult["condition"] | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<
    Array<{ file: File; preview: string }>
  >([]);

  // Extraction result + editable fields
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [listingUrl, setListingUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [upc, setUpc] = useState("");
  const [condition, setCondition] =
    useState<ExtractionResult["condition"]>("Good");
  const [category, setCategory] = useState("");
  const [shippingService, setShippingService] =
    useState<ExtractionResult["suggestedShippingService"]>(
      "MANUAL_ESTIMATE_NEEDED"
    );
  const [price, setPrice] = useState("");
  const [priceRationale, setPriceRationale] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingText = useLoadingStage(stage === "analyzing");

  const reset = useCallback(() => {
    selectedFiles.forEach((f) => URL.revokeObjectURL(f.preview));
    setSelectedFiles([]);
    setSelectedCondition(null);
    setStage("idle");
    setError("");
    setExtraction(null);
    setListingUrl("");
    setCopied(false);
    setPrice("");
    setPriceRationale(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [selectedFiles]);

  // ── File selection (multi-image, max 5) ───────────────────────────────────

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const remaining = 5 - selectedFiles.length;
    const newFiles = Array.from(files).slice(0, remaining);
    const additions = newFiles.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));
    setSelectedFiles((prev) => [...prev, ...additions].slice(0, 5));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => {
      const copy = [...prev];
      URL.revokeObjectURL(copy[index].preview);
      copy.splice(index, 1);
      return copy;
    });
  }

  // ── Analyze all images ────────────────────────────────────────────────────

  async function handleAnalyze() {
    if (selectedFiles.length === 0 || !selectedCondition) return;
    setStage("preparing");
    setError("");

    const prepared: Array<{ data: string; mimeType: string }> = [];

    for (const sf of selectedFiles) {
      const {
        blob,
        mimeType,
        error: prepError,
      } = await prepareImageForUpload(sf.file);

      if (prepError) {
        setError(prepError);
        setStage("error");
        return;
      }

      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      prepared.push({ data: base64, mimeType });
    }

    setStage("analyzing");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: prepared,
          condition: selectedCondition,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(
          data.error ?? "Analysis failed. Please try different photos."
        );
        setStage("error");
        return;
      }

      const result = data as ExtractionResult;
      setExtraction(result);
      setTitle(result.title);
      setBrand(result.brand ?? "");
      setModel(result.model ?? "");
      setUpc(result.upc ?? "");
      setCondition(selectedCondition);
      setCategory(result.category);
      setShippingService(result.suggestedShippingService);
      if (
        result.suggestedPrice !== null &&
        result.suggestedPrice !== undefined
      ) {
        setPrice(result.suggestedPrice.toFixed(2));
      }
      setPriceRationale(result.priceRationale ?? null);
      setStage("review");

      try {
        posthog?.capture("item_analyzed", {
          condition: selectedCondition,
          category: result.category,
        });
      } catch {
        // Analytics blocked (ad-blocker) — non-critical
      }
    } catch {
      setError("Connection failed. Please check your network and try again.");
      setStage("error");
    }
  }

  // ── Stripe listing link creation ──────────────────────────────────────────

  async function handleGenerateLink() {
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
      setError(
        "Please enter a valid price before generating your listing link."
      );
      return;
    }
    setError("");
    setStage("generating");

    const parts: string[] = [];
    if (brand) parts.push(`Brand: ${brand}`);
    if (model) parts.push(`Model: ${model}`);
    parts.push(`Condition: ${condition}`);
    if (extraction?.specs) {
      Object.entries(extraction.specs)
        .slice(0, 5)
        .forEach(([k, v]) => parts.push(`${k}: ${v}`));
    }
    parts.push(`Shipping: ${SHIPPING_DISPLAY_NAMES[shippingService]}`);

    try {
      const res = await fetch("/api/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_APP_INTERNAL_BETA_KEY ?? "",
        },
        body: JSON.stringify({
          title,
          price: parseFloat(price),
          description: parts.join(" · "),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.url) {
        setError(
          data.error ??
            "Could not create your listing link. Please try again."
        );
        setStage("review");
        return;
      }

      setListingUrl(data.url);
      setStage("done");
    } catch {
      setError("Connection failed. Please try again.");
      setStage("review");
    }
  }

  // ── Copy link ─────────────────────────────────────────────────────────────

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(listingUrl);
    } catch {
      const el = document.createElement("textarea");
      el.value = listingUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!authChecked) {
    return (
      <main className="flex-1 bg-gray-50 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  return (
    <main className="flex-1 bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-6">
        {/* Header */}
        <div className="text-center">
          <p className="text-sm text-gray-500 mt-1">
            Photograph an item. Get a listing in seconds.
          </p>
        </div>

        {/* Hidden file input — multiple enabled for multi-image */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,.heic"
          multiple
          className="hidden"
          onChange={handleFilesSelected}
        />

        {/* ── Idle: Condition-first → Photos → Analyze ───────────────────── */}
        {stage === "idle" && (
          <div className="flex flex-col gap-4">
            {/* Step 1: Condition selector (always visible) */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold">
                  1
                </span>
                <label className="text-sm font-semibold text-gray-800">
                  Select item condition
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {CONDITIONS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setSelectedCondition(c)}
                    className={`px-4 py-2 rounded-full text-sm font-medium border transition-all ${
                      selectedCondition === c
                        ? `${CONDITION_COLORS[c]} ring-2 ring-offset-1 ring-blue-400`
                        : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2: Photo upload (only appears after condition selected) */}
            {selectedCondition && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold">
                    2
                  </span>
                  <label className="text-sm font-semibold text-gray-800">
                    Add photos{" "}
                    <span className="font-normal text-gray-400">
                      (up to 5)
                    </span>
                  </label>
                </div>

                {selectedFiles.length === 0 ? (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-3 w-full h-44 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors cursor-pointer"
                  >
                    <svg
                      className="w-10 h-10"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    <span className="font-medium text-sm">
                      Take photos or choose files
                    </span>
                    <span className="text-xs">
                      JPEG · PNG · WebP · HEIC up to 5 MB each
                    </span>
                  </button>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-gray-500">
                        {selectedFiles.length} of 5 photos
                      </p>
                      <button
                        onClick={() => {
                          selectedFiles.forEach((f) =>
                            URL.revokeObjectURL(f.preview)
                          );
                          setSelectedFiles([]);
                        }}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Clear all
                      </button>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                      {selectedFiles.map((sf, i) => (
                        <div key={i} className="relative aspect-square">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={sf.preview}
                            alt={`Photo ${i + 1}`}
                            className="w-full h-full object-cover rounded-lg border border-gray-200"
                          />
                          <button
                            onClick={() => removeFile(i)}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center shadow-sm hover:bg-red-600 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                      {selectedFiles.length < 5 && (
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="aspect-square rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors"
                        >
                          <Plus className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Analyze button (only when condition + photos ready) */}
            {selectedCondition && selectedFiles.length > 0 && (
              <button
                onClick={() => void handleAnalyze()}
                disabled={stage !== "idle"}
                className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Analyze {selectedFiles.length} photo
                {selectedFiles.length !== 1 ? "s" : ""} as &quot;
                {selectedCondition}&quot; →
              </button>
            )}
          </div>
        )}

        {/* ── Preparing / Analyzing: progress ────────────────────────────── */}
        {(stage === "preparing" || stage === "analyzing") && (
          <div className="flex flex-col items-center gap-5 py-12">
            <div className="flex gap-2 justify-center">
              {selectedFiles.map((sf, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={sf.preview}
                  alt={`Photo ${i + 1}`}
                  className="w-16 h-16 object-cover rounded-lg shadow-sm"
                />
              ))}
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium text-gray-700">
                {stage === "preparing" ? "Processing photos..." : loadingText}
              </p>
              {selectedCondition && (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${CONDITION_COLORS[selectedCondition]}`}
                >
                  {selectedCondition}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Review: editable extraction result ─────────────────────────── */}
        {(stage === "review" || stage === "generating") && extraction && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              <div className="flex gap-1.5 flex-shrink-0">
                {selectedFiles.slice(0, 3).map((sf, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={sf.preview}
                    alt={`Photo ${i + 1}`}
                    className="w-12 h-12 object-cover rounded-lg shadow-sm"
                  />
                ))}
                {selectedFiles.length > 3 && (
                  <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-medium text-gray-500">
                    +{selectedFiles.length - 3}
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500">
                  Review and edit, then set your price.
                </p>
                <button
                  onClick={reset}
                  className="text-xs text-blue-600 hover:underline mt-0.5"
                >
                  Start over with new photos
                </button>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-4">
              <Field
                label="Title"
                indicator={
                  <NeedsReview
                    field="title"
                    confidence={extraction.confidence}
                  />
                }
              >
                <input
                  className={inputClass}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Brand"
                  indicator={
                    <NeedsReview
                      field="brand"
                      confidence={extraction.confidence}
                    />
                  }
                >
                  <input
                    className={inputClass}
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="—"
                  />
                </Field>
                <Field
                  label="Model"
                  indicator={
                    <NeedsReview
                      field="model"
                      confidence={extraction.confidence}
                    />
                  }
                >
                  <input
                    className={inputClass}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="—"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="UPC"
                  indicator={
                    <NeedsReview
                      field="upc"
                      confidence={extraction.confidence}
                    />
                  }
                >
                  <input
                    className={inputClass}
                    value={upc}
                    onChange={(e) => setUpc(e.target.value)}
                    placeholder="—"
                  />
                </Field>
                <Field label="Condition">
                  <select
                    className={inputClass}
                    value={condition}
                    onChange={(e) =>
                      setCondition(
                        e.target.value as ExtractionResult["condition"]
                      )
                    }
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field
                label="Category"
                indicator={
                  <NeedsReview
                    field="category"
                    confidence={extraction.confidence}
                  />
                }
              >
                <input
                  className={inputClass}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </Field>

              {/* Specs: read-only key-value display */}
              {extraction.specs &&
                Object.keys(extraction.specs).length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-600 mb-2 flex items-center">
                      Specs
                      <NeedsReview
                        field="specs"
                        confidence={extraction.confidence}
                      />
                    </p>
                    <div className="rounded-lg border border-gray-100 divide-y divide-gray-100 text-sm">
                      {Object.entries(extraction.specs).map(([k, v]) => (
                        <div key={k} className="flex px-3 py-1.5">
                          <span className="w-1/2 text-gray-500 truncate">
                            {k}
                          </span>
                          <span className="w-1/2 font-medium text-gray-800 truncate">
                            {v}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              <Field
                label="Shipping"
                indicator={
                  <NeedsReview
                    field="suggestedShippingService"
                    confidence={extraction.confidence}
                  />
                }
              >
                <select
                  className={inputClass}
                  value={shippingService}
                  onChange={(e) =>
                    setShippingService(
                      e.target
                        .value as ExtractionResult["suggestedShippingService"]
                    )
                  }
                >
                  {getAllFlatRates().map((r) => (
                    <option key={r.service} value={r.service}>
                      {r.displayName}
                    </option>
                  ))}
                  <option value="MANUAL_ESTIMATE_NEEDED">
                    {SHIPPING_DISPLAY_NAMES.MANUAL_ESTIMATE_NEEDED}
                  </option>
                </select>
                {shippingService === "MANUAL_ESTIMATE_NEEDED" && (
                  <p className="text-xs text-orange-600 mt-1">
                    Shipping estimate unavailable — factor this into your price
                    or check USPS.com for rates.
                  </p>
                )}
              </Field>

              {/* Price — pre-filled by Claude, editable by seller */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  Asking price (USD)
                  {priceRationale && (
                    <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
                      AI suggested
                    </span>
                  )}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                    $
                  </span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    className={`${inputClass} pl-7`}
                    placeholder="0.00"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </div>
                {priceRationale && (
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                    {priceRationale}
                  </p>
                )}
                {!priceRationale && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    Claude couldn&apos;t estimate a price — enter one manually.
                  </p>
                )}
              </div>
            </div>

            {/* Inline error from a failed link-creation retry */}
            {error && stage === "review" && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              onClick={() => void handleGenerateLink()}
              disabled={stage === "generating" || !price}
              className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {stage === "generating"
                ? "Creating listing link..."
                : "Generate listing link →"}
            </button>
          </div>
        )}

        {/* ── Done: payment link ready ────────────────────────────────────── */}
        {stage === "done" && (
          <div className="flex flex-col gap-5">
            <div className="bg-white rounded-2xl border border-green-200 shadow-sm p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2 text-green-700">
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="font-semibold">Listing link ready!</span>
              </div>

              <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 break-all font-mono">
                {listingUrl}
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => void copyLink()}
                  className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition-colors"
                >
                  {copied ? "Copied!" : "Copy link"}
                </button>
                <a
                  href={listingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-3 rounded-xl border border-gray-200 text-gray-700 font-medium text-sm text-center hover:bg-gray-50 transition-colors"
                >
                  Open payment page
                </a>
              </div>
            </div>

            <button
              onClick={reset}
              className="text-sm text-gray-500 hover:text-gray-700 text-center"
            >
              List another item
            </button>
          </div>
        )}

        {/* ── Error: terminal (analysis failed) ──────────────────────────── */}
        {stage === "error" && (
          <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5 flex flex-col gap-4">
            {selectedFiles.length > 0 && (
              <div className="flex gap-2 justify-center">
                {selectedFiles.slice(0, 3).map((sf, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={sf.preview}
                    alt={`Photo ${i + 1}`}
                    className="w-16 h-16 object-cover rounded-lg opacity-60"
                  />
                ))}
              </div>
            )}
            <div className="text-center">
              <p className="font-semibold text-gray-900">
                Could not analyze these photos
              </p>
              <p className="text-sm text-gray-500 mt-1">{error}</p>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  reset();
                  setTimeout(() => fileInputRef.current?.click(), 50);
                }}
                className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition-colors"
              >
                Try different photos
              </button>
              <button
                onClick={reset}
                className="w-full py-3 rounded-xl border border-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-50 transition-colors"
              >
                Start over
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
