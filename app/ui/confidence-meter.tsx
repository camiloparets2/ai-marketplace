// ConfidenceMeter — the identification confidence bar with the 0.80
// auto-post threshold marked (the same gate lib/guardrails.ts enforces —
// keep AUTO_POST_THRESHOLD in sync with GUARDRAIL_DEFAULTS.minConfidence).
// The tone helper is exported pure for tests. Server-safe.

export const AUTO_POST_THRESHOLD = 0.8;

export type ConfidenceTone = "ok" | "warn" | "danger";

export function confidenceTone(value: number): ConfidenceTone {
  if (value >= AUTO_POST_THRESHOLD) return "ok";
  if (value >= 0.6) return "warn";
  return "danger";
}

const BAR: Record<ConfidenceTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
};

const TEXT: Record<ConfidenceTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
};

export function ConfidenceMeter({
  value,
  className = "",
}: {
  // 0–1 from lib/ai/vision.ts
  value: number;
  className?: string;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  const tone = confidenceTone(clamped);
  const pct = Math.round(clamped * 100);
  const autoPost = clamped >= AUTO_POST_THRESHOLD;

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-gray-500">Identification confidence</span>
        <span className={`font-semibold ${TEXT[tone]}`}>{pct}%</span>
      </div>
      <div
        role="meter"
        aria-label="Identification confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%${autoPost ? ", clears" : ", below"} the ${Math.round(AUTO_POST_THRESHOLD * 100)}% auto-post bar`}
        className="relative h-2 rounded-full bg-gray-100 overflow-hidden"
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${BAR[tone]}`}
          style={{ width: `${pct}%` }}
        />
        {/* the 0.80 auto-post threshold mark */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-gray-400"
          style={{ left: `${AUTO_POST_THRESHOLD * 100}%` }}
        />
      </div>
      <p className={`text-xs ${autoPost ? "text-gray-400" : TEXT[tone]}`}>
        {autoPost
          ? `Clears the ${Math.round(AUTO_POST_THRESHOLD * 100)}% bar — eligible to auto-post.`
          : `Below the ${Math.round(AUTO_POST_THRESHOLD * 100)}% auto-post bar — will be held for your review.`}
      </p>
    </div>
  );
}
