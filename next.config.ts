import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Anthropic and Stripe SDKs server-side only — prevents Vercel from
  // attempting to bundle them into the edge runtime.
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe"],
};

export default nextConfig;
