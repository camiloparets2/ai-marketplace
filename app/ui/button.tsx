// Shared Button (docs/design/design-system.md). Wraps the .btn-primary /
// .btn-secondary layer classes so every screen gets the same CTA language,
// 44px touch targets, and disabled/loading semantics. Server-safe.

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost:
    "inline-flex items-center justify-center gap-2 text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  danger:
    "inline-flex items-center justify-center gap-2 bg-red-600 text-white hover:bg-red-700 transition-colors active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
};

// md/lg meet the 44px touch bar; sm is for dense desktop-only contexts.
const SIZE: Record<Size, string> = {
  sm: "text-sm px-3 py-1.5 rounded-lg",
  md: "text-sm font-medium px-4 min-h-touch rounded-(--radius-control)",
  lg: "text-base font-semibold px-6 min-h-12 rounded-(--radius-control)",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${VARIANT[variant]} ${SIZE[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      )}
      {children}
    </button>
  );
}
