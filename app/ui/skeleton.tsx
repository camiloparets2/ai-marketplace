// Skeleton — loading placeholders that match the shapes they replace.
// Wrap groups in aria-busy on the container; skeletons themselves are
// decorative. Server-safe.

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse bg-gray-200/80 rounded-lg ${className}`}
    />
  );
}

/** A card-shaped skeleton matching the inventory/list row layout. */
export function SkeletonCard() {
  return (
    <div className="bg-white rounded-(--radius-card) border border-gray-100 shadow-sm p-4 flex gap-3">
      <Skeleton className="w-16 h-16 flex-shrink-0" />
      <div className="flex-1 flex flex-col gap-2 py-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
