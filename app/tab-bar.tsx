"use client";

// Native-style bottom tab bar — the core of the app-like phone experience.
// Phones only (hidden ≥ sm); shows on the signed-in app pages and stays out
// of the way on public/marketing/auth pages. Pads itself with the safe-area
// inset so it clears iPhone home indicators.

import Link from "next/link";
import { usePathname } from "next/navigation";

const APP_PAGES = new Set([
  "/",
  "/inventory",
  "/dashboard",
  "/channels",
  "/billing",
]);

interface Tab {
  href: string;
  label: string;
  // Heroicon-style 24x24 outline path(s)
  d: string[];
}

const TABS: Tab[] = [
  {
    href: "/dashboard",
    label: "Home",
    d: [
      "M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75",
    ],
  },
  {
    href: "/",
    label: "Snap",
    d: [
      "M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C3.001 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z",
      "M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z",
    ],
  },
  {
    href: "/inventory",
    label: "Items",
    d: [
      "M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z",
    ],
  },
  {
    href: "/channels",
    label: "Channels",
    d: [
      "M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244",
    ],
  },
  {
    href: "/billing",
    label: "Billing",
    d: [
      "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z",
    ],
  },
];

export default function AppTabBar() {
  const pathname = usePathname();
  if (!APP_PAGES.has(pathname)) return null;

  return (
    <>
      {/* In-flow spacer so page content never hides behind the fixed bar */}
      <div className="h-20 sm:hidden" aria-hidden="true" />
      <nav
        className="sm:hidden fixed bottom-0 inset-x-0 z-50 bg-white/95 backdrop-blur border-t border-gray-200"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="App navigation"
      >
        <div className="flex justify-around">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`flex flex-col items-center gap-0.5 py-2 px-3 min-w-[56px] ${
                  active ? "text-blue-600" : "text-gray-400"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2 : 1.5}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  {tab.d.map((d, i) => (
                    <path
                      key={i}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d={d}
                    />
                  ))}
                </svg>
                <span
                  className={`text-[10px] ${active ? "font-semibold" : "font-medium"}`}
                >
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
