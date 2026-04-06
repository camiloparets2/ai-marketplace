"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  Camera,
  LayoutDashboard,
  LogOut,
  LogIn,
  Compass,
} from "lucide-react";
import { createClient } from "@/utils/supabase/client";

export default function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data: { user } }) => {
      setEmail(user?.email ?? null);
      setLoading(false);
    });
  }, [pathname]); // re-check on route change

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const linkClass = (href: string) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
      pathname === href
        ? "bg-blue-50 text-blue-700"
        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
    }`;

  return (
    <nav className="w-full bg-white border-b border-gray-100 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto flex items-center justify-between px-4 h-14">
        {/* Logo */}
        <Link href="/" className="font-bold text-gray-900 text-lg">
          Snap to List
        </Link>

        {/* Nav links */}
        {loading ? (
          <div className="h-5 w-32 bg-gray-100 rounded animate-pulse" />
        ) : (
          <div className="flex items-center gap-1">
            {/* Explore — always visible (public) */}
            <Link href="/explore" className={linkClass("/explore")}>
              <Compass className="w-4 h-4" />
              Explore
            </Link>

            {email ? (
              <>
                <Link href="/" className={linkClass("/")}>
                  <Camera className="w-4 h-4" />
                  Scanner
                </Link>
                <Link href="/dashboard" className={linkClass("/dashboard")}>
                  <LayoutDashboard className="w-4 h-4" />
                  Dashboard
                </Link>
                <button
                  onClick={() => void handleSignOut()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-700 transition-colors ml-2"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </>
            ) : (
              <Link
                href="/login"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <LogIn className="w-4 h-4" />
                Sign In
              </Link>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
