import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel routes all /api/* requests to the same region as the deployment.
  // The analyze route makes a Claude Vision API call that can take up to 30s —
  // increase the function timeout to 60s to give headroom.
  // See: https://vercel.com/docs/functions/configuring-functions/duration
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe"],
};

export default nextConfig;
