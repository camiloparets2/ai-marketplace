"use client";

// Authenticated reset-password page. Users arrive here from the recovery
// email via /auth/callback (which establishes the session); middleware
// bounces signed-out visitors to /login.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const inputClass =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        // Covers weak passwords and expired recovery sessions with Supabase's
        // own safe messages.
        setError(err.message);
        setBusy(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not update your password. Please request a new link.");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-sm flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Choose a new password
          </h1>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="flex flex-col gap-3"
          >
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="New password (8+ characters)"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Confirm new password"
              className={inputClass}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full py-3 rounded-xl btn-primary font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              {busy ? "Updating..." : "Update password"}
            </button>
            {error && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
