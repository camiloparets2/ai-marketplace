"use client";

// Inventory — every published item, where it's live, and the sold/delist
// actions that keep channels in sync (the "never oversell" surface).
// Signed-out visitors are bounced to /login by middleware.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface ListingRow {
  id: string;
  platform: string;
  url: string | null;
  status: "live" | "ended" | "end_failed";
  last_error: string | null;
}

interface Item {
  id: string;
  title: string;
  condition: string;
  photo_url: string | null;
  quantity: number;
  // null until the pricing engine (or the seller) prices the draft
  price: number | null;
  cost_of_goods: number | null;
  status: "draft" | "review" | "listed" | "sold" | "archived";
  sold_at: string | null;
  sold_price: number | null;
  sold_platform: string | null;
  created_at: string;
  listings: ListingRow[];
}

const PLATFORM_NAMES: Record<string, string> = {
  ebay: "eBay",
  etsy: "Etsy",
  shopify: "Shopify",
  direct: "Direct link",
};

const STATUS_STYLES: Record<Item["status"], string> = {
  draft: "bg-gray-100 text-gray-600",
  review: "bg-amber-50 text-amber-700",
  listed: "bg-blue-50 text-blue-700",
  sold: "bg-green-50 text-green-700",
  archived: "bg-gray-100 text-gray-400",
};

export default function InventoryPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyItem, setBusyItem] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [syncing, setSyncing] = useState(false);
  // Item id whose "mark sold" platform picker is open
  const [soldPicker, setSoldPicker] = useState<string>("");
  // Item id whose cost editor is open, and its in-progress value
  const [costEditor, setCostEditor] = useState<string>("");
  const [costValue, setCostValue] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory");
      if (res.status === 401) {
        window.location.assign("/login?next=/inventory");
        return;
      }
      const data = (await res.json()) as { items?: Item[] };
      setItems(data.items ?? []);
    } catch {
      // keep whatever we had
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Deferred so the effect body stays free of (statically traceable)
    // synchronous setState.
    queueMicrotask(() => void load());
  }, [load]);

  async function runAction(
    itemId: string,
    body: { action: string; platform?: string; costOfGoods?: number }
  ) {
    setBusyItem(itemId);
    setNotice("");
    setSoldPicker("");
    setCostEditor("");
    try {
      const res = await fetch(`/api/inventory/${itemId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        endResults?: Array<{ platform: string; ok: boolean; error?: string }>;
      };
      if (!res.ok) {
        setNotice(data.error ?? "Action failed. Please try again.");
      } else if (data.endResults && data.endResults.some((r) => !r.ok)) {
        const failed = data.endResults.filter((r) => !r.ok);
        setNotice(
          `Some listings could not be ended: ${failed
            .map((f) => `${PLATFORM_NAMES[f.platform] ?? f.platform} (${f.error ?? "error"})`)
            .join(", ")}. Run the action again to retry.`
        );
      }
      await load();
    } catch {
      setNotice("Connection failed. Please try again.");
    }
    setBusyItem("");
  }

  async function syncSales() {
    setSyncing(true);
    setNotice("");
    try {
      const res = await fetch("/api/sync/orders", { method: "POST" });
      const data = (await res.json()) as {
        results?: Array<{ platform: string; itemsSold: number; error?: string }>;
        error?: string;
      };
      if (!res.ok) {
        setNotice(data.error ?? "Sync failed. Please try again.");
      } else {
        const sold = (data.results ?? []).reduce((n, r) => n + r.itemsSold, 0);
        const errors = (data.results ?? []).filter((r) => r.error);
        setNotice(
          sold > 0
            ? `Synced — ${sold} item${sold === 1 ? "" : "s"} marked sold and delisted elsewhere.`
            : errors.length > 0
              ? `Sync issue: ${errors.map((e) => `${PLATFORM_NAMES[e.platform] ?? e.platform}: ${e.error}`).join("; ")}`
              : "Synced — no new sales found."
        );
      }
      await load();
    } catch {
      setNotice("Connection failed. Please try again.");
    }
    setSyncing(false);
  }

  // Platforms a sale can be attributed to: the item's channels plus the
  // assisted ones (sales there happen off-platform).
  function soldPlatformChoices(item: Item): string[] {
    const fromListings = item.listings.map((l) => l.platform);
    return [...new Set([...fromListings, "facebook", "offerup", "other"])];
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every item, every channel — marking one sold ends it everywhere.
          </p>
          <button
            onClick={() => void syncSales()}
            disabled={syncing}
            className="mt-2 text-xs text-blue-600 hover:underline disabled:opacity-50"
          >
            {syncing ? "Checking eBay & Etsy..." : "↻ Check for new sales"}
          </button>
        </div>

        {notice && (
          <p className="text-sm text-orange-700 bg-orange-50 rounded-lg px-3 py-2">
            {notice}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
            <p className="text-sm text-gray-500">
              Nothing here yet — items land in inventory automatically when
              you publish.
            </p>
            <Link
              href="/"
              className="inline-block mt-4 px-4 py-2 rounded-xl btn-primary font-semibold text-sm transition-colors"
            >
              List an item →
            </Link>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-3"
            >
              <div className="flex gap-3">
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
                    {item.price !== null
                      ? `$${Number(item.price).toFixed(2)}`
                      : "unpriced"}
                    {item.status === "sold" && item.sold_price !== null && (
                      <span className="text-green-700">
                        {" "}· sold ${Number(item.sold_price).toFixed(2)}
                        {item.sold_platform
                          ? ` on ${PLATFORM_NAMES[item.sold_platform] ?? item.sold_platform}`
                          : ""}
                      </span>
                    )}
                  </p>
                  <span
                    className={`inline-block mt-1 text-xs font-medium px-1.5 py-0.5 rounded ${STATUS_STYLES[item.status]}`}
                  >
                    {item.status}
                  </span>
                  {/* Cost of goods → per-item profit */}
                  <p className="text-xs text-gray-400 mt-1">
                    {costEditor === item.id ? (
                      <span className="inline-flex items-center gap-1">
                        cost $
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          autoFocus
                          className="w-20 rounded border border-gray-200 px-1.5 py-0.5 text-xs"
                          value={costValue}
                          onChange={(e) => setCostValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const cost = parseFloat(costValue);
                              if (isFinite(cost) && cost >= 0) {
                                void runAction(item.id, {
                                  action: "set_cost",
                                  costOfGoods: cost,
                                });
                              }
                            }
                            if (e.key === "Escape") setCostEditor("");
                          }}
                        />
                        <button
                          onClick={() => {
                            const cost = parseFloat(costValue);
                            if (isFinite(cost) && cost >= 0) {
                              void runAction(item.id, {
                                action: "set_cost",
                                costOfGoods: cost,
                              });
                            }
                          }}
                          className="text-blue-600 hover:underline"
                        >
                          Save
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setCostEditor(item.id);
                          setCostValue(
                            item.cost_of_goods !== null
                              ? String(item.cost_of_goods)
                              : ""
                          );
                        }}
                        className="hover:underline"
                      >
                        {item.cost_of_goods !== null ? (
                          <>
                            cost ${Number(item.cost_of_goods).toFixed(2)}
                            {item.status === "sold" &&
                              item.sold_price !== null && (
                                <span
                                  className={
                                    Number(item.sold_price) -
                                      Number(item.cost_of_goods) >=
                                    0
                                      ? " text-green-700"
                                      : " text-red-600"
                                  }
                                >
                                  {" "}· profit $
                                  {(
                                    Number(item.sold_price) -
                                    Number(item.cost_of_goods)
                                  ).toFixed(2)}
                                </span>
                              )}
                            {" ✎"}
                          </>
                        ) : (
                          "+ add cost for profit tracking"
                        )}
                      </button>
                    )}
                  </p>
                </div>
              </div>

              {item.listings.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {item.listings.map((l) => (
                    <a
                      key={l.id}
                      href={l.url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`text-xs px-2 py-0.5 rounded-full border ${
                        l.status === "live"
                          ? "border-blue-200 text-blue-700 bg-blue-50"
                          : l.status === "end_failed"
                            ? "border-red-200 text-red-600 bg-red-50"
                            : "border-gray-200 text-gray-400 bg-gray-50 line-through"
                      }`}
                      title={l.last_error ?? undefined}
                    >
                      {PLATFORM_NAMES[l.platform] ?? l.platform}
                      {l.status === "end_failed" && " ⚠"}
                    </a>
                  ))}
                </div>
              )}

              {item.status !== "archived" && (
                <div className="flex gap-2">
                  {item.status !== "sold" && (
                    <>
                      {soldPicker === item.id ? (
                        <select
                          className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                          defaultValue=""
                          disabled={busyItem === item.id}
                          onChange={(e) => {
                            if (e.target.value) {
                              void runAction(item.id, {
                                action: "sold",
                                platform: e.target.value,
                              });
                            }
                          }}
                        >
                          <option value="" disabled>
                            Sold where?
                          </option>
                          {soldPlatformChoices(item).map((p) => (
                            <option key={p} value={p}>
                              {PLATFORM_NAMES[p] ??
                                (p === "other"
                                  ? "Somewhere else"
                                  : p === "facebook"
                                    ? "Facebook Marketplace"
                                    : p === "offerup"
                                      ? "OfferUp"
                                      : p)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          onClick={() => setSoldPicker(item.id)}
                          disabled={busyItem === item.id}
                          className="flex-1 py-1.5 rounded-lg bg-green-600 text-white font-medium text-sm hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                          {busyItem === item.id ? "Working..." : "Mark sold"}
                        </button>
                      )}
                      {item.listings.some(
                        (l) => l.status === "live" || l.status === "end_failed"
                      ) && (
                        <button
                          onClick={() => void runAction(item.id, { action: "delist" })}
                          disabled={busyItem === item.id}
                          className="flex-1 py-1.5 rounded-lg border border-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          Delist all
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => void runAction(item.id, { action: "archive" })}
                    disabled={busyItem === item.id}
                    className="py-1.5 px-3 rounded-lg border border-gray-200 text-gray-400 font-medium text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    Archive
                  </button>
                </div>
              )}
            </div>
          ))
        )}

        <Link href="/" className="text-sm text-blue-600 hover:underline text-center">
          ← Back to Snap to List
        </Link>
      </div>
    </main>
  );
}
