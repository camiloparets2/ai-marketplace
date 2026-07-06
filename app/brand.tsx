// Brand mark + wordmark — one visual identity across landing, auth, and the
// app header, matching the home-screen app icon (blue rounded square,
// camera with price-tag dot). Server-safe: no hooks.

export function BrandMark({ className = "w-9 h-9" }: { className?: string }) {
  return (
    <span
      className={`${className} inline-flex items-center justify-center rounded-[22%] bg-gradient-to-br from-blue-600 to-indigo-600 shadow-md shadow-blue-600/25`}
      aria-hidden="true"
    >
      <svg
        className="w-[62%] h-[62%]"
        fill="none"
        stroke="#ffffff"
        strokeWidth={1.7}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
        />
        <circle cx="17.5" cy="9.5" r="0.9" fill="#ffffff" stroke="none" />
      </svg>
    </span>
  );
}

export function BrandWordmark({
  markClassName = "w-9 h-9",
  textClassName = "text-2xl",
}: {
  markClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark className={markClassName} />
      <span
        className={`${textClassName} font-bold tracking-tight text-brand-gradient`}
      >
        Snap to List
      </span>
    </span>
  );
}
