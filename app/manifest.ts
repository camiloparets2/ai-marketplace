// Web app manifest — makes Snap to List installable on phones (Add to Home
// Screen → launches fullscreen like a native app, same account and data as
// the website because it IS the website). Served at /manifest.webmanifest.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Snap to List",
    short_name: "SnapToList",
    description:
      "Photograph an item. AI drafts the listing. Publish to eBay, Etsy, Shopify, and more — and never oversell.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f9fafb",
    theme_color: "#2563eb",
    categories: ["business", "shopping", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
