"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { ExtractionResult } from "@/lib/types/extraction";
import {
  CONFIDENCE_THRESHOLD,
  CRITICAL_FIELDS,
  SHIPPING_DISPLAY_NAMES,
} from "@/lib/types/extraction";
import { getAllFlatRates, getShippingRate } from "@/lib/shipping";
import { prepareImageForUpload } from "@/lib/image-validation";
import type { AcceptedMimeType } from "@/lib/image-validation";
import { PLATFORM_DISPLAY_NAMES } from "@/lib/platforms/types";
import type { ApiPlatform } from "@/lib/platforms/types";
import {
  createSupabaseBrowserClient,
  isSupabaseAuthConfigured,
} from "@/lib/supabase/client";
import { BrandWordmark } from "@/app/brand";
import { ConfidenceMeter } from "@/app/ui/confidence-meter";
import { PricingPanel } from "@/app/ui/pricing-panel";
import { overallConfidence } from "@/lib/ai/confidence";

// ─── Stage machine ────────────────────────────────────────────────────────────

type Stage =
  | "idle"       // upload prompt
  | "preparing"  // HEIC conversion + compression (client-side)
  | "analyzing"  // API call in flight
  | "review"     // extraction result, editable
  | "publishing" // multi-platform publish in flight
  | "published"  // per-platform results ready
  | "error";     // terminal error

// ─── Publish targets ──────────────────────────────────────────────────────────

type PublishTarget =
  | "ebay"
  | "etsy"
  | "shopify"
  | "facebook"
  | "offerup"
  | "direct";

const TARGET_LABELS: Record<PublishTarget, string> = {
  ...PLATFORM_DISPLAY_NAMES,
  direct: "Direct payment link",
};

// Mirrors the /api/publish response shape.
type TargetResult =
  | { platform: PublishTarget; status: "live"; url: string }
  | {
      platform: PublishTarget;
      status: "assist";
      postUrl: string;
      copyText: string;
      title: string;
      description: string;
      price: number;
    }
  | { platform: PublishTarget; status: "not_connected"; connectUrl: string }
  | {
      platform: PublishTarget;
      status: "error";
      message: string;
      // In-app fix the user can click through to (e.g. add ship-from).
      actionUrl?: string;
      actionLabel?: string;
    };

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
    if (!active) return;
    // Advance through the stage labels on a fixed schedule; each stage's ms is
    // the time spent in that stage, so timers fire at the cumulative offsets.
    let elapsed = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    ANALYSIS_STAGES.forEach((stage, i) => {
      if (stage.ms === Infinity) return;
      elapsed += stage.ms;
      timers.push(setTimeout(() => setIndex(i + 1), elapsed));
    });
    return () => {
      for (const t of timers) clearTimeout(t);
      setIndex(0);
    };
  }, [active]);

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

// ─── Clipboard helper ─────────────────────────────────────────────────────────

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers that block the Clipboard API
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string>("");
  const [preview, setPreview] = useState<string>("");
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [copiedKey, setCopiedKey] = useState<string>("");

  // The processed photo, kept for the publish call (eBay/Etsy need the bytes).
  const [imageBase64, setImageBase64] = useState<string>("");
  const [imageMime, setImageMime] = useState<AcceptedMimeType>("image/jpeg");

  // Marketplace connection state + publish selection
  const [connections, setConnections] = useState<Record<ApiPlatform, boolean>>({
    ebay: false,
    etsy: false,
    shopify: false,
  });
  const [targets, setTargets] = useState<Set<PublishTarget>>(
    new Set(["facebook", "offerup", "direct"])
  );
  const [results, setResults] = useState<TargetResult[]>([]);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  // Signed-in user's email for the account header; null in legacy beta mode.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  // AI credits remaining; null → unknown (signed out / billing not migrated).
  const [creditsLeft, setCreditsLeft] = useState<number | null>(null);
  // Set when analysis failed specifically for lack of credits → upgrade CTA.
  const [outOfCredits, setOutOfCredits] = useState(false);

  // Editable extraction fields — initialised from API response, user can change
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [upc, setUpc] = useState("");
  const [condition, setCondition] =
    useState<ExtractionResult["condition"]>("Good");
  const [category, setCategory] = useState("");
  // Manual shipping cost, required when no service estimate exists — unknown
  // shipping must never publish as if shipping were free (the money rule).
  const [manualShipCost, setManualShipCost] = useState<string>("");
  const [shippingService, setShippingService] =
    useState<ExtractionResult["suggestedShippingService"]>(
      "MANUAL_ESTIMATE_NEEDED"
    );
  const [price, setPrice] = useState("");
  // One-line explanation of the AI's suggested price, shown by the price field.
  const [priceRationale, setPriceRationale] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingText = useLoadingStage(stage === "analyzing");

  // ── Connections + OAuth redirect banner ─────────────────────────────────────

  useEffect(() => {
    // Toast from OAuth callback redirects (?connected=ebay / ?connect_error=…)
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const connectError = params.get("connect_error");
    if (connected || connectError) {
      // Deferred so the effect body stays free of synchronous setState.
      queueMicrotask(() =>
        setBanner(
          connected
            ? {
                kind: "success",
                text: `${TARGET_LABELS[connected as PublishTarget] ?? connected} connected!`,
              }
            : { kind: "error", text: connectError ?? "" }
        )
      );
      window.history.replaceState({}, "", window.location.pathname);
    }

    // Who's signed in (session cookie flows automatically).
    void fetch("/api/auth/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { email?: string | null } | null) => {
        if (data?.email) setAccountEmail(data.email);
      })
      .catch(() => undefined);

    // Credits remaining for the header chip (401 in legacy mode → ignored).
    void fetch("/api/billing/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { creditsRemaining?: number | null } | null) => {
        if (typeof data?.creditsRemaining === "number") {
          setCreditsLeft(data.creditsRemaining);
        }
      })
      .catch(() => undefined);

    void fetch("/api/connections")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connections?: Record<ApiPlatform, boolean> } | null) => {
        if (!data?.connections) return;
        setConnections(data.connections);
        // Pre-select connected marketplaces — the point of the product is
        // "one tap, listed everywhere you can be".
        setTargets((prev) => {
          const next = new Set(prev);
          if (data.connections?.ebay) next.add("ebay");
          if (data.connections?.etsy) next.add("etsy");
          if (data.connections?.shopify) next.add("shopify");
          return next;
        });
      })
      .catch(() => undefined);
  }, []);

  // Reset back to idle so the user can start a new listing
  const reset = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview);
    setStage("idle");
    setError("");
    setOutOfCredits(false);
    setPreview("");
    setExtraction(null);
    setResults([]);
    setCopiedKey("");
    setPrice("");
    setPriceRationale(null);
    setImageBase64("");
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
    setImageBase64(base64);
    setImageMime(mimeType);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64, mimeType }),
      });

      const data = await res.json();

      if (!res.ok) {
        setOutOfCredits(res.status === 402);
        setError(
          data.error ?? "Analysis failed. Please try a different photo."
        );
        setStage("error");
        return;
      }

      setOutOfCredits(false);
      // One credit consumed — reflect it without waiting for a refetch.
      setCreditsLeft((c) => (c !== null && c > 0 ? c - 1 : c));
      const result = data as ExtractionResult;
      setExtraction(result);
      setTitle(result.title);
      setBrand(result.brand ?? "");
      setModel(result.model ?? "");
      setUpc(result.upc ?? "");
      setCondition(result.condition);
      setCategory(result.category);
      setShippingService(result.suggestedShippingService);
      // The AI's recommended price pre-fills the EDITABLE field — always
      // shown when present, never gated. Below-floor prices warn (in
      // PricingPanel) but never block a manual publish.
      setPrice(
        typeof result.suggestedPrice === "number" && result.suggestedPrice > 0
          ? result.suggestedPrice.toFixed(2)
          : ""
      );
      setPriceRationale(result.priceRationale ?? null);
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

  // ── Multi-platform publish ──────────────────────────────────────────────────

  function toggleTarget(target: PublishTarget) {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }

  // null exactly when there's no service estimate AND no valid manual cost —
  // in that state publishing is blocked.
  const parsedManualShip = parseFloat(manualShipCost);
  const effectiveShippingCost: number | null =
    shippingService === "MANUAL_ESTIMATE_NEEDED"
      ? manualShipCost.trim() !== "" &&
        isFinite(parsedManualShip) &&
        parsedManualShip >= 0
        ? parsedManualShip
        : null
      : getShippingRate(shippingService).cost;

  async function handlePublish() {
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
      setError("Please enter a valid price before publishing.");
      return;
    }
    if (effectiveShippingCost === null) {
      setError(
        "We couldn't estimate shipping for this item — enter a shipping cost or pick a service before publishing."
      );
      return;
    }
    if (targets.size === 0) {
      setError("Pick at least one place to list.");
      return;
    }
    setError("");
    setStage("publishing");

    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing: {
            title,
            brand: brand || null,
            model: model || null,
            upc: upc || null,
            condition,
            category,
            specs: extraction?.specs ?? {},
            price: parseFloat(price),
            shippingCost: effectiveShippingCost,
          },
          image: imageBase64,
          mimeType: imageMime,
          targets: [...targets],
        }),
      });

      const data = await res.json();

      if (!res.ok || !Array.isArray(data.results)) {
        setError(data.error ?? "Publishing failed. Please try again.");
        setStage("review"); // let them retry without starting over
        return;
      }

      setResults(data.results as TargetResult[]);
      setStage("published");
    } catch {
      setError("Connection failed. Please try again.");
      setStage("review");
    }
  }

  // ── Copy helper with per-button feedback ────────────────────────────────────

  async function copyWithFeedback(key: string, text: string) {
    await writeClipboard(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 2000);
  }

  // ── Sign out ────────────────────────────────────────────────────────────────

  async function handleSignOut() {
    if (isSupabaseAuthConfigured()) {
      await createSupabaseBrowserClient().auth.signOut();
    }
    window.location.assign("/login");
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-6">

        {/* Header */}
        <div className="text-center">
          {/* h1 for the document outline; Tailwind preflight keeps it
              visually identical to the bare wordmark */}
          <h1 className="flex justify-center">
            <BrandWordmark />
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Photograph an item. AI drafts the listing — you review, then publish to eBay.
          </p>
          {accountEmail && (
            <p className="text-xs text-gray-400 mt-2">
              {accountEmail}
              {" · "}
              <a href="/dashboard" className="text-blue-600 hover:underline">
                Dashboard
              </a>
              {" · "}
              <Link href="/inventory" className="text-blue-600 hover:underline">
                Inventory
              </Link>
              {creditsLeft !== null && (
                <>
                  {" · "}
                  <a href="/billing" className="hover:underline">
                    <span
                      className={
                        creditsLeft === 0 ? "text-red-600 font-medium" : ""
                      }
                    >
                      {creditsLeft} credit{creditsLeft === 1 ? "" : "s"} left
                    </span>
                  </a>
                </>
              )}
              {" · "}
              <button
                onClick={() => void handleSignOut()}
                className="text-blue-600 hover:underline"
              >
                Sign out
              </button>
            </p>
          )}
        </div>

        {/* OAuth result banner */}
        {banner && (
          <div
            className={`text-sm rounded-lg px-3 py-2 flex justify-between items-center ${
              banner.kind === "success"
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-600"
            }`}
          >
            <span>{banner.text}</span>
            <button
              onClick={() => setBanner(null)}
              className="ml-2 font-bold opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── Idle: upload prompt ─────────────────────────────────────────── */}
        {stage === "idle" && (
          <>
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

            {/* Capture nudge — a readable brand tag is what lets the AI
                assert a brand instead of downgrading to "Unbranded". */}
            <p className="text-xs text-gray-500 text-center -mt-2">
              Best shot: front · back · <span className="font-medium">brand tag or label close-up</span>.
              A readable tag means better identification and stronger price comps.
            </p>

            {/* Marketplace connections — connect once, publish forever */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2">
              <p className="text-sm font-medium text-gray-700">
                Marketplace accounts
              </p>
              {(["ebay", "etsy", "shopify"] as const).map((p) => (
                <div
                  key={p}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-600">{TARGET_LABELS[p]}</span>
                  {connections[p] ? (
                    <span className="text-green-600 font-medium">
                      ✓ Connected
                    </span>
                  ) : (
                    <a
                      // Shopify connect needs a shop domain — collected on the hub.
                      href={p === "shopify" ? "/channels" : `/api/oauth/${p}/start`}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      Connect →
                    </a>
                  )}
                </div>
              ))}
              <p className="text-xs text-gray-400 mt-1">
                Facebook Marketplace and OfferUp don&apos;t offer listing APIs —
                you&apos;ll get a one-tap assisted post instead.{" "}
                <a href="/channels" className="text-blue-600 hover:underline">
                  Manage channels →
                </a>
              </p>
            </div>
          </>
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
        {(stage === "review" || stage === "publishing") && extraction && (
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

            {/* Identification confidence — the 0.80 auto-post bar is marked */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <ConfidenceMeter value={overallConfidence(extraction)} />
            </div>

            {/* Defect chips — honest condition, fewer INAD returns */}
            {extraction.defects && extraction.defects.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium text-gray-700">
                  Visible flaws
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {extraction.defects.map((d, i) => (
                    <span
                      key={i}
                      className="text-xs bg-warn-surface text-warn border border-amber-200 px-2 py-0.5 rounded-badge"
                    >
                      {d}
                    </span>
                  ))}
                </div>
              </div>
            )}

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
                  <div className="mt-1 flex flex-col gap-1.5">
                    <p className="text-xs text-orange-600">
                      We couldn&apos;t estimate shipping for this item — enter a
                      shipping cost or pick a service. Publishing is blocked
                      until then (check USPS.com for rates).
                    </p>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                        $
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        aria-label="Shipping cost (USD)"
                        placeholder="Your shipping cost"
                        className={`${inputClass} pl-7`}
                        value={manualShipCost}
                        onChange={(e) => setManualShipCost(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </Field>

              {/* Price + floor + comps + unprofitable warning */}
              <PricingPanel
                price={price}
                onPriceChange={setPrice}
                costBasis={null}
                shippingCost={effectiveShippingCost}
                compsQuery={title}
                compsBrand={brand}
                compsCondition={condition}
                aiRationale={priceRationale}
              />
            </div>

            {/* Platform selection */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-3">
              <p className="text-sm font-medium text-gray-700">List on</p>
              {(
                [
                  "ebay",
                  "etsy",
                  "shopify",
                  "facebook",
                  "offerup",
                  "direct",
                ] as const
              ).map((t) => {
                const isApi = t === "ebay" || t === "etsy" || t === "shopify";
                const needsConnect = isApi && !connections[t as ApiPlatform];
                return (
                  <label
                    key={t}
                    className="flex items-center justify-between text-sm py-1 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-blue-600"
                        checked={targets.has(t)}
                        disabled={needsConnect}
                        onChange={() => toggleTarget(t)}
                      />
                      <span
                        className={
                          needsConnect ? "text-gray-400" : "text-gray-700"
                        }
                      >
                        {TARGET_LABELS[t]}
                      </span>
                      {(t === "facebook" || t === "offerup") && (
                        <span className="text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">
                          assisted
                        </span>
                      )}
                    </span>
                    {needsConnect && (
                      <a
                        href={
                          t === "shopify" ? "/channels" : `/api/oauth/${t}/start`
                        }
                        className="text-blue-600 hover:underline text-xs font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Connect →
                      </a>
                    )}
                  </label>
                );
              })}
              <p className="text-xs text-gray-400">
                Facebook Marketplace and OfferUp have no listing APIs — assisted
                posting copies your listing and opens their post page.
              </p>
            </div>

            {/* Inline error from a failed publish retry */}
            {error && stage === "review" && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              onClick={() => void handlePublish()}
              disabled={
                stage === "publishing" ||
                !price ||
                targets.size === 0 ||
                effectiveShippingCost === null
              }
              className="w-full py-3 rounded-xl btn-primary font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {stage === "publishing"
                ? "Publishing..."
                : `Publish to ${targets.size} ${targets.size === 1 ? "place" : "places"} →`}
            </button>
          </div>
        )}

        {/* ── Published: per-platform results ─────────────────────────────── */}
        {stage === "published" && (
          <div className="flex flex-col gap-4">
            {results.map((r) => (
              <div
                key={r.platform}
                className={`bg-white rounded-2xl border shadow-sm p-5 flex flex-col gap-3 ${
                  r.status === "live"
                    ? "border-green-200"
                    : r.status === "assist"
                      ? "border-purple-200"
                      : "border-red-100"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-900">
                    {TARGET_LABELS[r.platform]}
                  </span>
                  {r.status === "live" && (
                    <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded">
                      ● Live
                    </span>
                  )}
                  {r.status === "assist" && (
                    <span className="text-xs font-medium text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
                      Ready to post
                    </span>
                  )}
                  {(r.status === "error" || r.status === "not_connected") && (
                    <span className="text-xs font-medium text-red-600 bg-red-50 px-2 py-0.5 rounded">
                      {r.status === "error" ? "Failed" : "Not connected"}
                    </span>
                  )}
                </div>

                {r.status === "live" && (
                  <>
                    <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-700 break-all font-mono">
                      {r.url}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          void copyWithFeedback(r.platform, r.url)
                        }
                        className="flex-1 py-2 rounded-lg btn-primary font-medium text-sm transition-colors"
                      >
                        {copiedKey === r.platform ? "Copied!" : "Copy link"}
                      </button>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 py-2 rounded-lg border border-gray-200 text-gray-700 font-medium text-sm text-center hover:bg-gray-50 transition-colors"
                      >
                        View ↗
                      </a>
                    </div>
                  </>
                )}

                {r.status === "assist" && (
                  <>
                    <p className="text-xs text-gray-500">
                      1. Copy your listing &nbsp;2. Save the photo &nbsp;3. Open{" "}
                      {TARGET_LABELS[r.platform]} and paste.
                    </p>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() =>
                          void copyWithFeedback(r.platform, r.copyText)
                        }
                        className="w-full py-2 rounded-lg btn-primary font-medium text-sm transition-colors"
                      >
                        {copiedKey === r.platform
                          ? "Copied!"
                          : "Copy listing text"}
                      </button>
                      <div className="flex gap-2">
                        <a
                          href={preview}
                          download="listing-photo.jpg"
                          className="flex-1 py-2 rounded-lg border border-gray-200 text-gray-700 font-medium text-sm text-center hover:bg-gray-50 transition-colors"
                        >
                          Save photo
                        </a>
                        <a
                          href={r.postUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-2 rounded-lg bg-purple-600 text-white font-medium text-sm text-center hover:bg-purple-700 transition-colors"
                        >
                          Open & paste ↗
                        </a>
                      </div>
                    </div>
                  </>
                )}

                {r.status === "not_connected" && (
                  <a
                    href={r.connectUrl}
                    className="w-full py-2 rounded-lg btn-primary font-medium text-sm text-center transition-colors"
                  >
                    Connect {TARGET_LABELS[r.platform]} →
                  </a>
                )}

                {r.status === "error" && (
                  <>
                    <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                      {r.message}
                    </p>
                    {r.actionUrl && (
                      <a
                        href={r.actionUrl}
                        className="w-full py-2 rounded-lg btn-primary font-medium text-sm text-center transition-colors"
                      >
                        {r.actionLabel ?? "Fix this →"}
                      </a>
                    )}
                  </>
                )}
              </div>
            ))}

            <div className="flex flex-col gap-1">
              {accountEmail && (
                <Link
                  href="/inventory"
                  className="text-sm text-blue-600 hover:underline text-center py-1"
                >
                  Saved to your inventory — manage it there →
                </Link>
              )}
              <button
                onClick={reset}
                className="text-sm text-gray-500 hover:text-gray-700 text-center py-2"
              >
                List another item
              </button>
            </div>
          </div>
        )}

        {/* ── Error: terminal (analysis failed / out of credits) ──────────── */}
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
                {outOfCredits
                  ? "You're out of AI credits"
                  : "Could not analyze this photo"}
              </p>
              <p className="text-sm text-gray-500 mt-1">{error}</p>
            </div>
            <div className="flex flex-col gap-2">
              {outOfCredits ? (
                <a
                  href="/pricing"
                  className="w-full py-3 rounded-xl btn-primary font-semibold text-sm text-center transition-colors"
                >
                  View plans →
                </a>
              ) : (
                <button
                  onClick={() => {
                    reset();
                    setTimeout(() => fileInputRef.current?.click(), 50);
                  }}
                  className="w-full py-3 rounded-xl btn-primary font-semibold text-sm transition-colors"
                >
                  Try a different photo
                </button>
              )}
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
