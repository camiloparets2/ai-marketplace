// 404 — a friendly dead-end with a way back into the app. Server component.

import Link from "next/link";
import { BrandWordmark } from "@/app/brand";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm flex flex-col items-center gap-4 text-center">
        <BrandWordmark />
        <div>
          <p className="text-base font-semibold text-gray-900">
            Page not found
          </p>
          <p className="text-sm text-gray-500 mt-1">
            That page doesn&apos;t exist or moved. Let&apos;s get you back to listing.
          </p>
        </div>
        <Link
          href="/"
          className="btn-primary text-sm font-medium px-5 min-h-touch rounded-(--radius-control)"
        >
          Back to Snap to List
        </Link>
      </div>
    </main>
  );
}
