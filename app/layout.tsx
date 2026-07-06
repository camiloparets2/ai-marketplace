import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

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
    default: "Snap to List — photograph it, it's listed everywhere",
    template: "%s — Snap to List",
  },
  description:
    "Take one photo. AI drafts the listing. Publish to eBay, Etsy, Shopify, and more in one tap — and never oversell: selling anywhere delists everywhere else.",
  openGraph: {
    title: "Snap to List",
    description:
      "One photo → listed on eBay, Etsy, Shopify, and more. Automatic cross-channel delisting when it sells.",
    type: "website",
  },
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
