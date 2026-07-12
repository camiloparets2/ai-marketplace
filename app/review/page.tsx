"use client";

// Review queue — the first-class home for items a guardrail (or the Etsy
// gate) held back from auto-posting. Each row shows the EXACT reason and the
// action: approve (release + publish), reject (archive), or edit the price
// before approving. Batch approve/reject for clearing a backlog fast.
//
// Approve respects the same publish gating as everything else — in
// sandbox/dry-run mode nothing hits a real marketplace.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/app/ui/button";
import { Card } from "@/app/ui/card";
import { EmptyState } from "@/app/ui/empty-state";
import { SkeletonCard } from "@/app/ui/skeleton";
import { useToast } from "@/app/ui/toast";

interface ReviewItem {
  id: string;
  title: string;
  photo_url: string | null;
  price: number | null;
  status: string;
  review_reasons: Array<{ gate: string; reason: string }>;
}

const GATE_LABELS: Record<string, string> = {
  confidence: "Low identification confidence",
  price_floor: "Price below break-even floor",
  price_range: "Price outside the safe range",
  prohibited_item: "Possibly prohibited / restricted",
  vero_brand: "Brand-protected (VeRO) — verify authenticity",
  photo_quality: "Photo quality too low",
  shipping_unknown:
    "No shipping estimate — enter a shipping cost or pick a service",
};

export default function ReviewPage() {
  const toast = useToast();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory");
      if (res.status === 401) {
        window.location.assign("/login?next=/review");
        return;
      }
      const data = (await res.json()) as { items?: ReviewItem[] };
      setItems((data.items ?? []).filter((i) => i.status === "review"));
    } catch {
      // keep prior state
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const runAction = useCallback(
    async (
      id: string,
      action: "approve" | "reject",
      price?: number
    ): Promise<boolean> => {
      setBusy((b) => new Set(b).add(id));
      try {
        const res = await fetch(`/api/inventory/${id}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(price !== undefined ? { action, price } : { action }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          toast.error(data.error ?? "Action failed");
          return false;
        }
        return true;
      } catch {
        toast.error("Connection failed");
        return false;
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        });
      }
    },
    [toast]
  );

  async function single(id: string, action: "approve" | "reject") {
    const ok = await runAction(id, action);
    if (ok) {
      toast.success(action === "approve" ? "Approved & posting" : "Rejected");
      await load();
    }
  }

  async function batch(action: "approve" | "reject") {
    const ids = [...selected];
    if (ids.length === 0) return;
    let done = 0;
    for (const id of ids) {
      if (await runAction(id, action)) done++;
    }
    setSelected(new Set());
    toast.success(`${done} item${done === 1 ? "" : "s"} ${action === "approve" ? "approved" : "rejected"}`);
    await load();
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6 pb-24">
      <div className="w-full max-w-lg mx-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Review queue</h1>
          <Link href="/inventory" className="text-sm text-blue-600 hover:underline">
            All items →
          </Link>
        </div>
        <p className="text-sm text-gray-500 -mt-2">
          Items an auto-post guardrail held back. Approve to publish, reject to archive.
        </p>

        {/* Batch bar */}
        {selected.size > 0 && (
          <div className="sticky top-2 z-10 flex items-center gap-2 bg-white rounded-(--radius-card) border border-gray-200 shadow-sm px-3 py-2">
            <span className="text-sm font-medium text-gray-700 flex-1">
              {selected.size} selected
            </span>
            <Button size="sm" variant="secondary" onClick={() => void batch("reject")}>
              Reject
            </Button>
            <Button size="sm" onClick={() => void batch("approve")}>
              Approve all
            </Button>
          </div>
        )}

        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : items.length === 0 ? (
          <EmptyState
            icon={
              <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
            title="Nothing to review"
            body="Every listing cleared the auto-post guardrails. New items that need a look will appear here."
            action={
              <Link href="/">
                <Button>Snap an item</Button>
              </Link>
            }
          />
        ) : (
          items.map((item) => {
            const isBusy = busy.has(item.id);
            return (
              <Card key={item.id} className="flex flex-col gap-3">
                <div className="flex gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 w-5 h-5 accent-blue-600 flex-shrink-0"
                    checked={selected.has(item.id)}
                    onChange={() => toggleSelect(item.id)}
                    aria-label={`Select ${item.title}`}
                  />
                  {item.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.photo_url}
                      alt={item.title}
                      className="w-16 h-16 object-cover rounded-lg flex-shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-gray-100 flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 text-sm truncate">
                      {item.title}
                    </p>
                    <p className="text-sm text-gray-500">
                      {item.price !== null ? `$${Number(item.price).toFixed(2)}` : "unpriced"}
                    </p>
                  </div>
                </div>

                {/* Why it's held */}
                <ul className="flex flex-col gap-1.5">
                  {(item.review_reasons ?? []).map((r) => (
                    <li
                      key={r.gate}
                      className="text-xs text-warn bg-warn-surface border border-amber-200 rounded-lg px-2.5 py-1.5"
                    >
                      <span className="font-medium">{GATE_LABELS[r.gate] ?? r.gate}</span>
                      <span className="text-gray-500"> — {r.reason}</span>
                    </li>
                  ))}
                </ul>

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    loading={isBusy}
                    onClick={() => void single(item.id, "approve")}
                  >
                    Approve &amp; post
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    disabled={isBusy}
                    onClick={() => void single(item.id, "reject")}
                  >
                    Reject
                  </Button>
                  <Link href="/inventory" className="flex-shrink-0">
                    <Button size="sm" variant="ghost">
                      Edit
                    </Button>
                  </Link>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </main>
  );
}
