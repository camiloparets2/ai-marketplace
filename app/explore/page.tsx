"use client";

import { useEffect, useState, useCallback } from "react";
import { Search, Box, Package, ShoppingCart, Loader2 } from "lucide-react";
import Image from "next/image";
import { toast } from "sonner";
import { usePostHog } from "posthog-js/react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Listing {
  id: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: string | null;
  category: string;
  suggested_price: number | null;
  suggested_shipping_service: string;
  stock_image_url: string | null;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GRADIENTS = [
  "from-blue-50 to-indigo-100",
  "from-green-50 to-emerald-100",
  "from-purple-50 to-violet-100",
  "from-amber-50 to-orange-100",
  "from-pink-50 to-rose-100",
  "from-cyan-50 to-teal-100",
];

function getCategoryGradient(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function getConditionColor(condition: string): string {
  switch (condition) {
    case "New":
      return "bg-green-100 text-green-700";
    case "Like New":
      return "bg-blue-100 text-blue-700";
    case "Good":
      return "bg-yellow-100 text-yellow-700";
    case "Fair":
      return "bg-orange-100 text-orange-700";
    case "Poor":
      return "bg-red-100 text-red-700";
    default:
      return "bg-gray-100 text-gray-600";
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ExplorePage() {
  const posthog = usePostHog();
  const [listings, setListings] = useState<Listing[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtering, setFiltering] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [buyingId, setBuyingId] = useState<string | null>(null);

  const fetchListings = useCallback(
    async (searchQuery: string, categoryFilter: string) => {
      setFiltering(true);
      try {
        const params = new URLSearchParams();
        if (searchQuery) params.set("search", searchQuery);
        if (categoryFilter) params.set("category", categoryFilter);

        const res = await fetch(`/api/explore?${params.toString()}`);
        if (!res.ok) {
          toast.error("Failed to load listings.");
          return;
        }
        const data = await res.json();
        setListings(data.listings ?? []);
        if (!categoryFilter && !searchQuery) {
          setCategories(data.categories ?? []);
        }
      } catch {
        toast.error("Failed to load listings. Please try again.");
      } finally {
        setLoading(false);
        setFiltering(false);
      }
    },
    []
  );

  // Initial load
  useEffect(() => {
    void fetchListings("", "");
  }, [fetchListings]);

  // Debounced search + category filter
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchListings(search, selectedCategory);
      if (search.trim()) {
        try {
          posthog?.capture("search_performed", { query: search.trim() });
        } catch {
          // Analytics blocked — non-critical
        }
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedCategory]);

  // ── Buy Now handler ────────────────────────────────────────────────────────
  async function handleBuyNow(itemId: string) {
    const item = listings.find((l) => l.id === itemId);
    try {
      posthog?.capture("buy_now_clicked", {
        item_id: itemId,
        price: item?.suggested_price,
      });
    } catch {
      // Analytics blocked — non-critical
    }

    setBuyingId(itemId);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId }),
      });

      const data = await res.json();

      if (!res.ok || !data.url) {
        toast.error(data.error ?? "Could not start checkout. Please try again.");
        return;
      }

      // Redirect to Stripe Checkout
      window.location.href = data.url;
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setBuyingId(null);
    }
  }

  return (
    <main className="flex-1 bg-gray-50 px-4 py-8">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Explore Marketplace
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Browse items listed by sellers on Snap to List
          </p>
        </div>

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search listings..."
            className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Category pills */}
        {categories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setSelectedCategory("")}
              className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                selectedCategory === ""
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
              }`}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() =>
                  setSelectedCategory(selectedCategory === c ? "" : c)
                }
                className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  selectedCategory === c
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden animate-pulse"
              >
                <div className="h-28 bg-gray-100" />
                <div className="p-4 flex flex-col gap-2">
                  <div className="bg-gray-200 rounded h-4 w-3/4" />
                  <div className="bg-gray-200 rounded h-3 w-1/2" />
                  <div className="bg-gray-200 rounded h-6 w-1/3 mt-2" />
                </div>
              </div>
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-16">
            <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="font-medium text-gray-700">No listings found</p>
            <p className="text-sm text-gray-500 mt-1">
              {search || selectedCategory
                ? "Try a different search or filter."
                : "No items have been published yet."}
            </p>
          </div>
        ) : (
          <div className={`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 transition-opacity ${filtering ? "opacity-60" : "opacity-100"}`}>
            {listings.map((l) => (
              <div
                key={l.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden flex flex-col"
              >
                {/* Product image or fallback */}
                <div className="relative h-36 bg-gray-50 flex items-center justify-center overflow-hidden">
                  {l.stock_image_url ? (
                    <Image
                      src={l.stock_image_url}
                      alt={l.title}
                      fill
                      className="object-contain p-2"
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      unoptimized
                    />
                  ) : (
                    <div
                      className={`w-full h-full bg-gradient-to-br ${getCategoryGradient(l.category)} flex items-center justify-center`}
                    >
                      <Box className="w-8 h-8 text-gray-300" />
                    </div>
                  )}
                </div>
                <div className="p-4 flex flex-col flex-1">
                  <h3 className="font-semibold text-gray-900 text-sm line-clamp-2 leading-snug">
                    {l.title}
                  </h3>
                  {(l.brand || l.model) && (
                    <p className="text-xs text-gray-500 mt-1 truncate">
                      {[l.brand, l.model].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {l.condition && (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${getConditionColor(l.condition)}`}
                      >
                        {l.condition}
                      </span>
                    )}
                    <span className="text-xs text-gray-400 truncate">
                      {l.category.includes(">")
                        ? l.category.split(">")[0].trim()
                        : l.category}
                    </span>
                  </div>

                  {/* Spacer to push price + button to bottom */}
                  <div className="mt-auto pt-3">
                    <div className="flex items-center justify-between mb-3">
                      {l.suggested_price != null ? (
                        <p className="text-lg font-bold text-gray-900">
                          ${l.suggested_price.toFixed(2)}
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400">No price</p>
                      )}
                      <span className="text-xs text-gray-400">
                        {timeAgo(l.created_at)}
                      </span>
                    </div>

                    {/* Buy Now button */}
                    {l.suggested_price != null && (
                      <button
                        onClick={() => void handleBuyNow(l.id)}
                        disabled={buyingId !== null}
                        className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                      >
                        {buyingId === l.id ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="w-4 h-4" />
                            Buy Now
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
