"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  ShoppingCart,
  Loader2,
  ArrowLeft,
  Tag,
  Truck,
  Box,
} from "lucide-react";
import Image from "next/image";
import { toast } from "sonner";
import { usePostHog } from "posthog-js/react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ListingDetail {
  id: string;
  title: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  condition: string | null;
  category: string;
  suggested_price: number | null;
  suggested_shipping_service: string;
  stock_image_url: string | null;
  original_image_urls: string[] | null;
  raw_specs: Record<string, string> | null;
  price_rationale: string | null;
  created_at: string;
}

// ─── Condition badge colors ──────────────────────────────────────────────────

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

// ─── Image gallery component ─────────────────────────────────────────────────

function ImageGallery({ images }: { images: string[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedIndexes, setFailedIndexes] = useState<Set<number>>(new Set());

  const validImages = images.filter((_, i) => !failedIndexes.has(i));
  const activeImage = images[activeIndex];

  function handlePrev() {
    setActiveIndex((i) => (i === 0 ? images.length - 1 : i - 1));
  }

  function handleNext() {
    setActiveIndex((i) => (i === images.length - 1 ? 0 : i + 1));
  }

  if (validImages.length === 0) {
    return (
      <div className="w-full aspect-square bg-gray-100 rounded-2xl flex items-center justify-center">
        <Box className="w-16 h-16 text-gray-300" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Main image */}
      <div className="relative w-full aspect-square bg-gray-50 rounded-2xl overflow-hidden border border-gray-200">
        {activeImage && !failedIndexes.has(activeIndex) ? (
          <Image
            src={activeImage}
            alt={`Product image ${activeIndex + 1}`}
            fill
            className="object-contain p-4"
            sizes="(max-width: 768px) 100vw, 50vw"
            unoptimized
            onError={() =>
              setFailedIndexes((prev) => new Set(prev).add(activeIndex))
            }
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Box className="w-16 h-16 text-gray-300" />
          </div>
        )}

        {/* Navigation arrows */}
        {images.length > 1 && (
          <>
            <button
              onClick={handlePrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center shadow-md hover:bg-white transition-colors"
            >
              <ChevronLeft className="w-5 h-5 text-gray-700" />
            </button>
            <button
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center shadow-md hover:bg-white transition-colors"
            >
              <ChevronRight className="w-5 h-5 text-gray-700" />
            </button>
          </>
        )}

        {/* Image type label */}
        {images.length > 1 && (
          <span className="absolute top-3 left-3 bg-black/60 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm">
            {activeIndex === 0 && images[0]?.includes("google")
              ? "Stock Photo"
              : `Photo ${activeIndex + 1} of ${images.length}`}
          </span>
        )}
      </div>

      {/* Thumbnail strip */}
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((src, i) => (
            <button
              key={i}
              onClick={() => setActiveIndex(i)}
              className={`relative w-16 h-16 rounded-lg overflow-hidden border-2 flex-shrink-0 transition-all ${
                i === activeIndex
                  ? "border-blue-500 ring-1 ring-blue-200"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              {!failedIndexes.has(i) ? (
                <Image
                  src={src}
                  alt={`Thumb ${i + 1}`}
                  fill
                  className="object-cover"
                  sizes="64px"
                  unoptimized
                  onError={() =>
                    setFailedIndexes((prev) => new Set(prev).add(i))
                  }
                />
              ) : (
                <div className="w-full h-full bg-gray-100 flex items-center justify-center">
                  <Box className="w-4 h-4 text-gray-300" />
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ListingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const posthog = usePostHog();
  const id = params.id as string;

  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [buyingId, setBuyingId] = useState<string | null>(null);

  const fetchListing = useCallback(async () => {
    try {
      const res = await fetch(`/api/listing/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        toast.error("Failed to load listing.");
        return;
      }
      const data = await res.json();
      setListing(data.listing);

      try {
        posthog?.capture("listing_viewed", {
          item_id: id,
          price: data.listing?.suggested_price,
        });
      } catch {
        // Analytics blocked — non-critical
      }
    } catch {
      toast.error("Failed to load listing.");
    } finally {
      setLoading(false);
    }
  }, [id, posthog]);

  useEffect(() => {
    void fetchListing();
  }, [fetchListing]);

  // ── Buy Now handler ─────────────────────────────────────────────────────
  async function handleBuyNow() {
    if (!listing) return;
    setBuyingId(listing.id);

    try {
      posthog?.capture("buy_now_clicked", {
        item_id: listing.id,
        price: listing.suggested_price,
        source: "detail_page",
      });
    } catch {
      // Analytics blocked
    }

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: listing.id }),
      });

      const data = await res.json();

      if (!res.ok || !data.url) {
        toast.error(
          data.error ?? "Could not start checkout. Please try again."
        );
        return;
      }

      window.location.href = data.url;
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setBuyingId(null);
    }
  }

  // ── Build gallery images array ────────────────────────────────────────
  function getGalleryImages(): string[] {
    if (!listing) return [];
    const images: string[] = [];
    if (listing.stock_image_url) images.push(listing.stock_image_url);
    if (listing.original_image_urls) {
      images.push(...listing.original_image_urls);
    }
    return images;
  }

  // ── Loading state ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <main className="flex-1 bg-gray-50 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  // ── 404 state ─────────────────────────────────────────────────────────
  if (notFound || !listing) {
    return (
      <main className="flex-1 bg-gray-50 px-4 py-16">
        <div className="max-w-lg mx-auto text-center">
          <Box className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            Listing Not Found
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            This listing may have been sold or removed.
          </p>
          <button
            onClick={() => router.push("/explore")}
            className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors"
          >
            Browse Marketplace
          </button>
        </div>
      </main>
    );
  }

  const galleryImages = getGalleryImages();

  // ── Detail layout ─────────────────────────────────────────────────────
  return (
    <main className="flex-1 bg-gray-50 px-4 py-6">
      <div className="max-w-5xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => router.push("/explore")}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Marketplace
        </button>

        {/* Split layout — gallery left, details right */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Left: Image gallery */}
          <div>
            <ImageGallery images={galleryImages} />
          </div>

          {/* Right: Details */}
          <div className="flex flex-col gap-5">
            {/* Title + brand */}
            <div>
              <h1 className="text-2xl font-bold text-gray-900 leading-tight">
                {listing.title}
              </h1>
              {(listing.brand || listing.model) && (
                <p className="text-sm text-gray-500 mt-1">
                  {[listing.brand, listing.model].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>

            {/* Price */}
            {listing.suggested_price != null && (
              <div>
                <p className="text-3xl font-bold text-gray-900">
                  ${listing.suggested_price.toFixed(2)}
                </p>
                {listing.price_rationale && (
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    {listing.price_rationale}
                  </p>
                )}
              </div>
            )}

            {/* Badges row */}
            <div className="flex flex-wrap gap-2">
              {listing.condition && (
                <span
                  className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold ${getConditionColor(listing.condition)}`}
                >
                  {listing.condition}
                </span>
              )}
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                <Tag className="w-3 h-3" />
                {listing.category.includes(">")
                  ? listing.category.split(">")[0].trim()
                  : listing.category}
              </span>
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                <Truck className="w-3 h-3" />
                {listing.suggested_shipping_service
                  .replace(/_/g, " ")
                  .replace("USPS ", "")}
              </span>
            </div>

            {/* Specs table */}
            {listing.raw_specs &&
              Object.keys(listing.raw_specs).length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-gray-700 mb-2">
                    Specifications
                  </h2>
                  <div className="rounded-xl border border-gray-200 divide-y divide-gray-100 text-sm">
                    {Object.entries(listing.raw_specs).map(([k, v]) => (
                      <div key={k} className="flex px-4 py-2.5">
                        <span className="w-2/5 text-gray-500">{k}</span>
                        <span className="w-3/5 font-medium text-gray-800">
                          {v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {listing.upc && (
              <p className="text-xs text-gray-400">UPC: {listing.upc}</p>
            )}

            {/* Buy Now button */}
            {listing.suggested_price != null && (
              <button
                onClick={() => void handleBuyNow()}
                disabled={buyingId !== null}
                className="w-full py-3.5 rounded-xl bg-blue-600 text-white font-semibold text-base hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 mt-2"
              >
                {buyingId ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <ShoppingCart className="w-5 h-5" />
                    Buy Now — ${listing.suggested_price.toFixed(2)}
                  </>
                )}
              </button>
            )}

            {/* Photo count note */}
            {listing.original_image_urls &&
              listing.original_image_urls.length > 0 && (
                <p className="text-xs text-gray-400 text-center">
                  {listing.original_image_urls.length} actual seller photo
                  {listing.original_image_urls.length !== 1 ? "s" : ""} included
                  in gallery
                </p>
              )}
          </div>
        </div>
      </div>
    </main>
  );
}
