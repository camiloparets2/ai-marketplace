import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppTabBar from "@/app/tab-bar";
import { ToastProvider } from "@/app/ui/toast";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Shared SEO/social metadata — the landing page (/welcome) is the ad target,
// so titles and OG tags matter for link previews and search.
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  ),
  title: {
    default: "Snap to List — turn photos into polished listings",
    template: "%s — Snap to List",
  },
  description:
    "Take one photo, review an AI-assisted listing draft, and publish through the marketplace connections you choose.",
  openGraph: {
    title: "Snap to List",
    description:
      "One photo becomes a review-ready listing you can publish through your connected marketplaces.",
    type: "website",
  },
  // Installed-app behavior on iOS (Android reads the manifest).
  appleWebApp: {
    capable: true,
    title: "Snap to List",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

// viewport-fit=cover lets the app paint edge-to-edge on notched phones; the
// tab bar pads itself with env(safe-area-inset-bottom).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ToastProvider>
          {children}
          {/* Native-style bottom navigation on phones (app pages only) */}
          <AppTabBar />
        </ToastProvider>
      </body>
    </html>
  );
}
