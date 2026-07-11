"use client";

// Ship-from location settings (docs/design/ship-from-location.md).
//
// Where a seller lands right after connecting eBay when no inventory
// location could be auto-detected (?connected=ebay), and where they edit
// the address later. Globally correct: country list is the full ISO set
// (labels via Intl.DisplayNames), the postal field adapts to countries
// without postal codes, and no format is US-assumed.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Input, Select } from "@/app/ui/field";
import {
  ISO_COUNTRY_CODES,
  countryUsesPostalCodes,
} from "@/lib/ship-from";
import type { ShipFromLocation } from "@/lib/ship-from";

type FieldErrors = Partial<Record<keyof ShipFromLocation, string>>;

interface ShipFromStatus {
  shipFrom: ShipFromLocation | null;
  ebay: { connected: boolean; locationReady: boolean };
}

interface SaveResponse {
  ok?: boolean;
  error?: string;
  fieldErrors?: FieldErrors;
  ebayLocation?: { status: "ready" | "pending" | "error"; message?: string };
}

export default function ShipFromPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const [ebay, setEbay] = useState<ShipFromStatus["ebay"]>({
    connected: false,
    locationReady: false,
  });

  const [country, setCountry] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [stateOrProvince, setStateOrProvince] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<{
    kind: "success" | "warn" | "error";
    text: string;
  } | null>(null);

  // Country options with localized display names, sorted by label.
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(undefined, { type: "region" });
    return [...ISO_COUNTRY_CODES]
      .map((code) => ({ code, label: names.of(code) ?? code }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  const postalRequired = country === "" || countryUsesPostalCodes(country);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "ebay") {
      queueMicrotask(() => setJustConnected(true));
      window.history.replaceState({}, "", window.location.pathname);
    }

    void fetch("/api/settings/ship-from")
      .then((res) => {
        if (res.status === 401) {
          window.location.assign("/login?next=/settings/ship-from");
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: ShipFromStatus | null) => {
        if (!data) return;
        setEbay(data.ebay);
        if (data.shipFrom) {
          setCountry(data.shipFrom.country);
          setPostalCode(data.shipFrom.postalCode ?? "");
          setCity(data.shipFrom.city ?? "");
          setStateOrProvince(data.shipFrom.stateOrProvince ?? "");
        }
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    setFieldErrors({});

    try {
      const res = await fetch("/api/settings/ship-from", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country, postalCode, city, stateOrProvince }),
      });
      const data = (await res.json()) as SaveResponse;

      if (!res.ok) {
        setFieldErrors(data.fieldErrors ?? {});
        setNotice({
          kind: "error",
          text: data.error ?? "Couldn't save — please try again.",
        });
        return;
      }

      if (data.ebayLocation?.status === "ready") {
        setEbay((prev) => ({ ...prev, locationReady: true }));
        setNotice({
          kind: "success",
          text: "Saved — your eBay ship-from location is ready. You're set to publish.",
        });
      } else if (data.ebayLocation?.status === "error") {
        setNotice({
          kind: "warn",
          text: `Address saved, but eBay didn't accept it yet: ${data.ebayLocation.message ?? "please double-check it."}`,
        });
      } else {
        setNotice({
          kind: "success",
          text: "Saved. We'll set up your eBay location when you connect or publish.",
        });
      }
    } catch {
      setNotice({
        kind: "error",
        text: "Connection failed. Please check your network and try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg flex flex-col gap-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Ship-from location
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Where your items ship from — marketplaces need it to show buyers
            accurate delivery estimates.
          </p>
        </div>

        {justConnected && (
          <p className="text-sm text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            eBay connected! One last step: add your ship-from location so we
            can publish your listings.
          </p>
        )}

        {notice && (
          <p
            role={notice.kind === "success" ? "status" : "alert"}
            className={`text-sm rounded-lg px-3 py-2 ${
              notice.kind === "success"
                ? "text-green-800 bg-green-50 border border-green-100"
                : notice.kind === "warn"
                  ? "text-warn bg-warn-surface border border-amber-200"
                  : "text-red-600 bg-red-50 border border-red-100"
            }`}
          >
            {notice.text}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <form
            onSubmit={(e) => void handleSave(e)}
            className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-4"
          >
            <Select
              label="Country"
              error={fieldErrors.country}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              required
            >
              <option value="" disabled>
                Select your country…
              </option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>

            <Input
              label={postalRequired ? "Postal code" : "Postal code (optional)"}
              error={fieldErrors.postalCode}
              hint={
                postalRequired
                  ? undefined
                  : "Your country doesn't use postal codes — city and region below are enough."
              }
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              autoComplete="postal-code"
              placeholder={postalRequired ? "" : "Leave blank if none"}
            />

            <Input
              label={postalRequired ? "City (optional)" : "City"}
              error={fieldErrors.city}
              value={city}
              onChange={(e) => setCity(e.target.value)}
              autoComplete="address-level2"
            />

            <Input
              label={
                postalRequired
                  ? "State / province (optional)"
                  : "State / province / region"
              }
              error={fieldErrors.stateOrProvince}
              value={stateOrProvince}
              onChange={(e) => setStateOrProvince(e.target.value)}
              autoComplete="address-level1"
            />

            {ebay.connected && ebay.locationReady && (
              <p className="text-xs text-gray-500">
                Your eBay inventory location is set up. Saving a new address
                updates what we use for future listings.
              </p>
            )}

            <button
              type="submit"
              disabled={saving || !country}
              className="w-full py-3 rounded-xl btn-primary font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving…" : "Save ship-from location"}
            </button>
          </form>
        )}

        <div className="flex flex-col gap-1 text-center">
          <Link
            href="/channels"
            className="text-sm text-blue-600 hover:underline"
          >
            Manage channels →
          </Link>
          <Link href="/" className="text-sm text-blue-600 hover:underline">
            ← Back to Snap to List
          </Link>
        </div>
      </div>
    </main>
  );
}
