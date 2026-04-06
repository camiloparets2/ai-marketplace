import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Anthropic and Stripe SDKs server-side only — prevents Vercel from
  // attempting to bundle them into the edge runtime.
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe", "@supabase/supabase-js"],
};

export default nextConfig;
