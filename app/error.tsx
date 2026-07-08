"use client";

// Global error boundary — catches render/runtime errors in any route segment
// and offers a recovery path instead of a blank screen. Client component per
// Next's error-boundary contract.

import { useEffect } from "react";
import { Button } from "@/app/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled error:", error);
  }, [error]);

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-(--radius-card) border border-gray-100 shadow-sm p-6 flex flex-col items-center gap-4 text-center">
        <div aria-hidden="true" className="text-danger">
          <svg className="w-10 h-10" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <div>
          <p className="text-base font-semibold text-gray-900">
            Something went wrong
          </p>
          <p className="text-sm text-gray-500 mt-1">
            An unexpected error interrupted this page. Try again — your data is safe.
          </p>
        </div>
        <div className="flex gap-2 w-full">
          <Button className="flex-1" onClick={reset}>
            Try again
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => window.location.assign("/")}
          >
            Go home
          </Button>
        </div>
      </div>
    </main>
  );
}
