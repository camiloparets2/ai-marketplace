import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Anthropic and Stripe SDKs server-side only — prevents Vercel from
  // attempting to bundle them into the edge runtime.
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe"],

  // The eBay/Etsy developer portals are registered with provider-first
  // callback paths (/api/ebay/oauth/callback). The app's canonical routes are
  // platform-parameterised (/api/oauth/[platform]/callback). Alias the
  // registered paths so OAuth redirects land without re-registering either
  // portal. Rewrites preserve query strings (code, state, etc.).
  async rewrites() {
    return [
      {
        source: "/api/ebay/oauth/callback",
        destination: "/api/oauth/ebay/callback",
      },
      {
        source: "/api/etsy/oauth/callback",
        destination: "/api/oauth/etsy/callback",
      },
    ];
  },
};

export default nextConfig;
