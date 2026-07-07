// Shared Card — the app's one container shape (white, rounded-2xl, hairline
// border, soft shadow), extracted from the pattern every screen already
// hand-rolled. Server-safe.

import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  // remove padding when the card manages its own internal layout
  flush?: boolean;
  children: ReactNode;
}

export function Card({ flush = false, className = "", children, ...rest }: CardProps) {
  return (
    <div
      className={`bg-white rounded-(--radius-card) border border-gray-100 shadow-sm ${
        flush ? "" : "p-4"
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
