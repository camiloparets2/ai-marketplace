"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ExtractionResult } from "@/lib/types/extraction";
import {
  CONFIDENCE_THRESHOLD,
  CRITICAL_FIELDS,
  SHIPPING_DISPLAY_NAMES,
} from "@/lib/types/extraction";
import { getAllFlatRates } from "@/lib/shipping";
import { prepareImageForUpload } from "@/lib/image-validation";

// ─── Stage machine ────────────────────────────────────────────────────────────

type Stage =
  | "idle"       // upload prompt
  | "preparing"  // HEIC conversion + compression (client-side)
  | "analyzing"  // API call in flight
  | "review"     // extraction result, editable
  | "generating" // Stripe link creation
  | "done"       // link ready
  | "error";     // terminal error

// ─── Loading progress stages ──────────────────────────────────────────────────
// Time-based — not tied to real API progress. Each label reinforces the
// product value proposition while the user waits.

const ANALYSIS_STAGES = [
  { text: "Analyzing photo...", ms: 2_000 },
  { text: "Identifying specs...", ms: 5_000 },
  { text: "Estimating shipping...", ms: 9_000 },
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
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string>("");
  const [preview, setPreview] = useState<string>("");
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [listingUrl, setListingUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // Editable extraction fields — initialised from API response, user can change
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingText = useLoadingStage(stage === "analyzing");

  // Reset back to idle so the user can start a new listing
  const reset = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview);
    setStage("idle");
    setError("");
    setPreview("");
    setExtraction(null);
    setListingUrl("");
    setCopied(false);
    setPrice("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [preview]);

  // ── Photo selection + upload pipeline ──────────────────────────────────────

  async function handleFile(file: File) {
    setStage("preparing");
    setError("");

    // Client-side pipeline: HEIC → JPEG, resize to 2048px, re-encode at 0.85 quality
    const {
      blob,
      mimeType,
      error: prepError,
    } = await prepareImageForUpload(file);

    if (prepError) {
      setError(prepError);
      setStage("error");
      return;
    }

    // Show a local preview immediately for visual feedback during the API call
    const objectUrl = URL.createObjectURL(blob);
    setPreview(objectUrl);
    setStage("analyzing");

    // Encode to base64 for the JSON body sent to /api/analyze
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_APP_INTERNAL_BETA_KEY ?? "",
        },
        body: JSON.stringify({ image: base64, mimeType }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(
          data.error ?? "Analysis failed. Please try a different photo."
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
      setCondition(result.condition);
      setCategory(result.category);
      setShippingService(result.suggestedShippingService);
      setStage("review");
    } catch {
      setError("Connection failed. Please check your network and try again.");
      setStage("error");
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  // ── Stripe listing link creation ────────────────────────────────────────────

  async function handleGenerateLink() {
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
      setError("Please enter a valid price before generating your listing link.");
      return;
    }
    setError("");
    setStage("generating");

    // Auto-build a Stripe product description from the extraction data
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
        setStage("review"); // let them retry without starting over
        return;
      }

      setListingUrl(data.url);
      setStage("done");
    } catch {
      setError("Connection failed. Please try again.");
      setStage("review");
    }
  }

  // ── Copy link ──────────────────────────────────────────────────────────────

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(listingUrl);
    } catch {
      // Fallback for browsers that block the Clipboard API
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

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-6">

        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Snap to List</h1>
          <p className="text-sm text-gray-500 mt-1">
            Photograph an item. Get a listing in seconds.
          </p>
        </div>

        {/* ── Idle: upload prompt ─────────────────────────────────────────── */}
        {stage === "idle" && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-3 w-full h-56 rounded-2xl border-2 border-dashed border-gray-300 bg-white text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors cursor-pointer"
          >
            <svg
              className="w-12 h-12"
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
            <span className="font-medium text-base">
              Take a photo or choose a file
            </span>
            <span className="text-xs">JPEG · PNG · WebP · HEIC up to 5 MB</span>
          </button>
        )}

        {/* Hidden file input — capture="environment" opens the rear camera on mobile */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,.heic"
          capture="environment"
          className="hidden"
          onChange={handleInputChange}
        />

        {/* ── Preparing / Analyzing: progress ─────────────────────────────── */}
        {(stage === "preparing" || stage === "analyzing") && (
          <div className="flex flex-col items-center gap-5 py-12">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="Your photo"
                className="w-32 h-32 object-cover rounded-xl shadow"
              />
            )}
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium text-gray-700">
                {stage === "preparing" ? "Processing photo..." : loadingText}
              </p>
            </div>
          </div>
        )}

        {/* ── Review: editable extraction result ──────────────────────────── */}
        {(stage === "review" || stage === "generating") && extraction && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview}
                  alt="Your photo"
                  className="w-16 h-16 object-cover rounded-lg shadow-sm flex-shrink-0"
                />
              )}
              <div>
                <p className="text-xs text-gray-500">
                  Review and edit, then set your price.
                </p>
                <button
                  onClick={reset}
                  className="text-xs text-blue-600 hover:underline mt-0.5"
                >
                  Use a different photo
                </button>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-4">
              <Field
                label="Title"
                indicator={
                  <NeedsReview field="title" confidence={extraction.confidence} />
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
                    <NeedsReview field="brand" confidence={extraction.confidence} />
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
                    <NeedsReview field="model" confidence={extraction.confidence} />
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
                    <NeedsReview field="upc" confidence={extraction.confidence} />
                  }
                >
                  <input
                    className={inputClass}
                    value={upc}
                    onChange={(e) => setUpc(e.target.value)}
                    placeholder="—"
                  />
                </Field>
                <Field
                  label="Condition"
                  indicator={
                    <NeedsReview
                      field="condition"
                      confidence={extraction.confidence}
                    />
                  }
                >
                  <select
                    className={inputClass}
                    value={condition}
                    onChange={(e) =>
                      setCondition(
                        e.target.value as ExtractionResult["condition"]
                      )
                    }
                  >
                    {(
                      [
                        "New",
                        "Like New",
                        "Very Good",
                        "Good",
                        "Acceptable",
                      ] as const
                    ).map((c) => (
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

              {/* Price — required to generate the Stripe Payment Link */}
              <Field label="Your asking price (USD)">
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
              </Field>
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

        {/* ── Done: payment link ready ─────────────────────────────────────── */}
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
                  Open payment page ↗
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

        {/* ── Error: terminal (analysis failed) ───────────────────────────── */}
        {stage === "error" && (
          <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5 flex flex-col gap-4">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="Your photo"
                className="w-20 h-20 object-cover rounded-lg mx-auto opacity-60"
              />
            )}
            <div className="text-center">
              <p className="font-semibold text-gray-900">
                Could not analyze this photo
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
                Try a different photo
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
