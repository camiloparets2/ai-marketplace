// Labeled form controls — Input and Select with consistent label, hint, and
// error wiring (aria-describedby/aria-invalid handled once, here).
// useId keeps them server-render safe.

import { useId } from "react";
import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

const CONTROL =
  "w-full rounded-(--radius-control) border bg-white px-3 min-h-touch text-base text-gray-900 placeholder:text-gray-400 disabled:bg-gray-50 disabled:text-gray-400";

function borderFor(error: string | undefined): string {
  return error
    ? "border-red-400 focus-visible:outline-red-600"
    : "border-gray-200";
}

interface FieldChrome {
  label: string;
  hint?: string;
  error?: string;
}

function Chrome({
  id,
  label,
  hint,
  error,
  hintId,
  errorId,
  children,
}: FieldChrome & { id: string; hintId: string; errorId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-gray-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface InputProps
  extends FieldChrome,
    Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {}

export function Input({ label, hint, error, className = "", ...rest }: InputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <Chrome id={id} label={label} hint={hint} error={error} hintId={hintId} errorId={errorId}>
      <input
        id={id}
        className={`${CONTROL} ${borderFor(error)} ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      />
    </Chrome>
  );
}

export interface SelectProps
  extends FieldChrome,
    Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  children: ReactNode;
}

export function Select({ label, hint, error, className = "", children, ...rest }: SelectProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <Chrome id={id} label={label} hint={hint} error={error} hintId={hintId} errorId={errorId}>
      <select
        id={id}
        className={`${CONTROL} ${borderFor(error)} ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      >
        {children}
      </select>
    </Chrome>
  );
}
