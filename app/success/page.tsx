"use client";

import Link from "next/link";
import { CheckCircle, ArrowRight } from "lucide-react";

export default function SuccessPage() {
  return (
    <main className="flex-1 bg-gray-50 flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
        <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-5">
          <CheckCircle className="w-8 h-8 text-green-600" />
        </div>

        <h1 className="text-2xl font-bold text-gray-900">
          Payment Successful!
        </h1>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          Thank you for your purchase. The seller will be notified and your item
          will be on its way soon.
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <Link
            href="/explore"
            className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
          >
            Continue Shopping
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </main>
  );
}
