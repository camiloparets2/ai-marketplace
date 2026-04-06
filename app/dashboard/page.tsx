"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Download, Package, DollarSign, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/utils/supabase/client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Listing {
  id: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: string;
  category: string;
  suggested_price: number | null;
  suggested_shipping_service: string;
  is_published: boolean;
  created_at: string;
}

// ─── Skeleton loader ─────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={`bg-gray-200 rounded animate-pulse ${className ?? ""}`}
    />
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  // ── Auth gate ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace("/login");
      } else {
        setAuthChecked(true);
      }
    });
  }, [router]);

  // ── Fetch listings ─────────────────────────────────────────────────────────
  const fetchListings = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) return;
      const data = await res.json();
      setListings(data.listings ?? []);
    } catch {
      toast.error("Failed to load your listings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authChecked) void fetchListings();
  }, [authChecked, fetchListings]);

  // ── Toggle publish (optimistic) ────────────────────────────────────────────
  async function handleTogglePublish(id: string, currentState: boolean) {
    const newState = !currentState;

    // Optimistic update
    setListings((prev) =>
      prev.map((l) => (l.id === id ? { ...l, is_published: newState } : l))
    );
    setTogglingIds((prev) => new Set(prev).add(id));

    try {
      const res = await fetch("/api/dashboard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, is_published: newState }),
      });

      if (!res.ok) {
        // Rollback
        setListings((prev) =>
          prev.map((l) =>
            l.id === id ? { ...l, is_published: currentState } : l
          )
        );
        toast.error("Could not update listing status.");
      } else {
        toast.success(newState ? "Listing published!" : "Listing unpublished.");
      }
    } catch {
      setListings((prev) =>
        prev.map((l) =>
          l.id === id ? { ...l, is_published: currentState } : l
        )
      );
      toast.error("Network error. Please try again.");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ── Delete listing (optimistic) ────────────────────────────────────────────
  async function handleDelete(id: string) {
    const prev = listings;
    setListings((l) => l.filter((item) => item.id !== id));

    try {
      const res = await fetch("/api/dashboard", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });

      if (!res.ok) {
        setListings(prev);
        toast.error("Could not delete that listing. Please try again.");
      } else {
        toast.success("Listing deleted.");
      }
    } catch {
      setListings(prev);
      toast.error("Network error. Please try again.");
    }
  }

  // ── Export CSV ──────────────────────────────────────────────────────────────
  function exportCsv() {
    if (listings.length === 0) {
      toast.error("No listings to export.");
      return;
    }

    const headers = [
      "Title",
      "Brand",
      "Model",
      "Condition",
      "Category",
      "Price",
      "Shipping",
      "Status",
      "Date",
    ];

    const rows = listings.map((l) => [
      l.title,
      l.brand ?? "",
      l.model ?? "",
      l.condition,
      l.category,
      l.suggested_price?.toFixed(2) ?? "",
      l.suggested_shipping_service,
      l.is_published ? "Published" : "Draft",
      new Date(l.created_at).toLocaleDateString(),
    ]);

    const csvContent = [headers, ...rows]
      .map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snap2list-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded!");
  }

  // ── Metrics ────────────────────────────────────────────────────────────────
  const totalScans = listings.length;
  const totalValue = listings.reduce(
    (sum, l) => sum + (l.suggested_price ?? 0),
    0
  );
  const publishedCount = listings.filter((l) => l.is_published).length;

  // ── Auth loading spinner ───────────────────────────────────────────────────
  if (!authChecked) {
    return (
      <main className="flex-1 bg-gray-50 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  return (
    <main className="flex-1 bg-gray-50 px-4 py-8">
      <div className="max-w-5xl mx-auto flex flex-col gap-6">
        {/* ── Header + Export ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <button
            onClick={exportCsv}
            disabled={listings.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>

        {/* ── Metric cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
              <Package className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Scans</p>
              {loading ? (
                <Skeleton className="h-7 w-12 mt-0.5" />
              ) : (
                <p className="text-2xl font-bold text-gray-900">
                  {totalScans}
                </p>
              )}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
            <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Inventory Value</p>
              {loading ? (
                <Skeleton className="h-7 w-20 mt-0.5" />
              ) : (
                <p className="text-2xl font-bold text-gray-900">
                  ${totalValue.toFixed(2)}
                </p>
              )}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
            <div className="w-10 h-10 bg-purple-50 rounded-lg flex items-center justify-center">
              <Eye className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Published</p>
              {loading ? (
                <Skeleton className="h-7 w-12 mt-0.5" />
              ) : (
                <p className="text-2xl font-bold text-gray-900">
                  {publishedCount}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Listings table ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {loading ? (
            <div className="p-5 flex flex-col gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : listings.length === 0 ? (
            <div className="p-12 text-center">
              <Package className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="font-medium text-gray-700">No scans yet</p>
              <p className="text-sm text-gray-500 mt-1">
                Go to the Scanner to analyze your first item.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/50">
                    <th className="text-left px-4 py-3 font-medium text-gray-500">
                      Title
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">
                      Category
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">
                      Condition
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">
                      Price
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-500">
                      Status
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">
                      Date
                    </th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {listings.map((l) => (
                    <tr
                      key={l.id}
                      className="hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 max-w-[200px] truncate">
                        {l.title}
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[150px] truncate hidden sm:table-cell">
                        {l.category}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                          {l.condition}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {l.suggested_price != null
                          ? `$${l.suggested_price.toFixed(2)}`
                          : "---"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() =>
                            void handleTogglePublish(l.id, l.is_published)
                          }
                          disabled={togglingIds.has(l.id)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors disabled:opacity-50 ${
                            l.is_published
                              ? "bg-green-100 text-green-700 hover:bg-green-200"
                              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                          }`}
                        >
                          {l.is_published ? (
                            <>
                              <Eye className="w-3 h-3" />
                              Published
                            </>
                          ) : (
                            <>
                              <EyeOff className="w-3 h-3" />
                              Draft
                            </>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500 hidden sm:table-cell">
                        {new Date(l.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-3">
                        <button
                          onClick={() => void handleDelete(l.id)}
                          title="Delete listing"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
