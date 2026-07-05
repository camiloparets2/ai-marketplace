"use client";

// Public forgot-password page (roadmap auth checklist). Sends a Supabase
// recovery email whose link lands on /auth/callback?next=/reset-password,
// where the session is established before the new password is set.

import { useState } from "react";
import Link from "next/link";
import {
  createSupabaseBrowserClient,
  isSupabaseAuthConfigured,
} from "@/lib/supabase/client";

const inputClass =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (err) {
        setError(err.message);
      } else {
        setSent(true);
      }
    } catch {
      setError("Password reset is not available right now.");
    }
    setBusy(false);
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-sm flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Reset password</h1>
          <p className="text-sm text-gray-500 mt-1">
            We&apos;ll email you a reset link.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 flex flex-col gap-4">
          {!isSupabaseAuthConfigured() ? (
            <p className="text-sm text-orange-700 bg-orange-50 rounded-lg px-3 py-2">
              Sign-in is not configured on this deployment.
            </p>
          ) : sent ? (
            <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
              If an account exists for {email}, a reset link is on its way.
              Check your inbox.
            </p>
          ) : (
            <form
              onSubmit={(e) => void handleSubmit(e)}
              className="flex flex-col gap-3"
            >
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className={inputClass}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {busy ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <Link
            href="/login"
            className="text-xs text-gray-500 hover:underline text-center"
          >
            ← Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
