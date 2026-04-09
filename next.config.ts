import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Anthropic and Stripe SDKs server-side only — prevents Vercel from
  // attempting to bundle them into the edge runtime.
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe", "@supabase/supabase-js"],

  // Allow external images — Google Custom Search returns URLs from any domain
  // (amazon.com, walmart.com, ebay.com, etc.). We use unoptimized on the
  // <Image> component as the primary bypass, but this wildcard ensures
  // Next.js never blocks a valid stock photo URL.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
