// StatusBadge — one vocabulary for every lifecycle state in the app
// (inventory items, marketplace listings, connections). The status→intent
// mapping is exported pure so tests can lock it. Server-safe.

export type Intent = "ok" | "warn" | "danger" | "info" | "muted";

// Every status string the app renders today, mapped to a semantic intent.
// Unknown statuses fall back to muted rather than crashing a row.
const STATUS_INTENT: Record<string, Intent> = {
  // inventory item lifecycle
  draft: "muted",
  review: "warn",
  listed: "info",
  sold: "ok",
  archived: "muted",
  // marketplace listing lifecycle
  live: "info",
  active: "info",
  ended: "muted",
  delisted: "muted",
  end_failed: "danger",
  error: "danger",
  // connections
  connected: "ok",
  expired: "warn",
  not_connected: "muted",
  // sold_events
  pending: "warn",
  processed: "ok",
  oversold: "danger",
  unmatched: "warn",
};

export function statusIntent(status: string): Intent {
  return STATUS_INTENT[status] ?? "muted";
}

const INTENT_CLASSES: Record<Intent, string> = {
  ok: "bg-ok-surface text-ok border-green-200",
  warn: "bg-warn-surface text-warn border-amber-200",
  danger: "bg-danger-surface text-danger border-red-200",
  info: "bg-info-surface text-info border-blue-200",
  muted: "bg-muted-surface text-muted border-gray-200",
};

const INTENT_DOT: Record<Intent, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  muted: "bg-gray-400",
};

export function StatusBadge({
  status,
  label,
  className = "",
}: {
  status: string;
  // display text; defaults to the status itself
  label?: string;
  className?: string;
}) {
  const intent = statusIntent(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-badge border ${INTENT_CLASSES[intent]} ${className}`}
    >
      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${INTENT_DOT[intent]}`} />
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}
