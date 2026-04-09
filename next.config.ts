import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Anthropic and Stripe SDKs server-side only — prevents Vercel from
  // attempting to bundle them into the edge runtime.
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe", "@supabase/supabase-js"],

  // Allow external images from Google Custom Search stock photos
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "encrypted-tbn0.gstatic.com",
      },
      {
        protocol: "https",
        hostname: "*.gstatic.com",
      },
      {
        protocol: "https",
        hostname: "**.googleusercontent.com",
      },
    ],
  },
};

export default nextConfig;
