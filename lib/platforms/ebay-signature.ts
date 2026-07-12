// X-EBAY-SIGNATURE verification for Notification API webhooks (order events
// and marketplace account deletion) — the same scheme eBay's official Event
// Notification SDKs implement:
//
//   1. The header is base64-encoded JSON:
//        { "alg": "ecdsa", "kid": "<public key id>", "signature": "<base64>",
//          "digest": "SHA1" }
//   2. The public key comes from
//        GET /commerce/notification/v1/public_key/{kid}
//      (application OAuth token), and is cached for 1 hour.
//   3. The signature verifies over the RAW request body bytes — routes must
//      call req.text() BEFORE any JSON parsing.
//
// Verdicts map to the route contract: invalid → 412, key infrastructure
// unavailable → 5xx (eBay retries). There is no bypass switch — an unsigned
// or unverifiable notification is never processed.

import { createVerify } from "crypto";
import { mintEbayAppToken, apiBase } from "@/lib/platforms/ebay";

export type SignatureVerdict =
  | { ok: true }
  // Header missing/malformed, unknown algorithm, or the signature simply
  // doesn't verify → respond 412 Precondition Failed.
  | { ok: false; reason: "invalid"; detail: string }
  // We couldn't OBTAIN the key material (token/key endpoint down or not
  // configured) → respond 5xx so eBay redelivers.
  | { ok: false; reason: "unavailable"; detail: string };

export interface EbayPublicKey {
  pem: string;
  digest: "SHA1" | "SHA256";
}

export type PublicKeyFetcher = (kid: string) => Promise<EbayPublicKey>;

interface SignatureHeader {
  alg: string;
  kid: string;
  signature: string;
  digest?: string;
}

// eBay returns the PEM as one line ("-----BEGIN PUBLIC KEY-----MFkw…-----END
// PUBLIC KEY-----"); Node's crypto needs real PEM framing.
export function normalizePem(raw: string): string {
  const body = raw
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

// ── 1-hour public-key cache (per the compliance requirement) ────────────────
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
const keyCache = new Map<string, { key: EbayPublicKey; expiresAt: number }>();

export function clearEbayKeyCacheForTests(): void {
  keyCache.clear();
}

async function fetchEbayPublicKey(kid: string): Promise<EbayPublicKey> {
  const token = await mintEbayAppToken();
  const res = await fetch(`${apiBase()}/commerce/notification/v1/public_key/${kid}`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`public key lookup failed (${res.status})`);
  }
  const data = (await res.json()) as { key?: string; digest?: string };
  if (!data.key) throw new Error("public key response had no key");
  return {
    pem: normalizePem(data.key),
    digest: data.digest === "SHA256" ? "SHA256" : "SHA1",
  };
}

function parseHeader(header: string): SignatureHeader | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(header, "base64").toString("utf8")
    ) as Partial<SignatureHeader>;
    if (
      typeof decoded.kid !== "string" ||
      !decoded.kid ||
      typeof decoded.signature !== "string" ||
      !decoded.signature
    ) {
      return null;
    }
    return {
      alg: decoded.alg ?? "ecdsa",
      kid: decoded.kid,
      signature: decoded.signature,
      digest: decoded.digest,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a webhook's X-EBAY-SIGNATURE over the raw body. `fetchKey` is
 * injectable for tests; production uses the cached Notification API lookup.
 */
export async function verifyEbaySignature(
  rawBody: string,
  signatureHeader: string | null,
  fetchKey: PublicKeyFetcher = fetchEbayPublicKey
): Promise<SignatureVerdict> {
  if (!signatureHeader) {
    return { ok: false, reason: "invalid", detail: "missing X-EBAY-SIGNATURE" };
  }
  const parsed = parseHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, reason: "invalid", detail: "malformed signature header" };
  }
  if (parsed.alg.toLowerCase() !== "ecdsa") {
    return {
      ok: false,
      reason: "invalid",
      detail: `unsupported algorithm ${parsed.alg}`,
    };
  }

  let key: EbayPublicKey;
  const cached = keyCache.get(parsed.kid);
  if (cached && cached.expiresAt > Date.now()) {
    key = cached.key;
  } else {
    try {
      key = await fetchKey(parsed.kid);
      keyCache.set(parsed.kid, {
        key,
        expiresAt: Date.now() + KEY_CACHE_TTL_MS,
      });
    } catch (err) {
      return {
        ok: false,
        reason: "unavailable",
        detail: err instanceof Error ? err.message : "key fetch failed",
      };
    }
  }

  try {
    const verifier = createVerify(key.digest);
    verifier.update(rawBody);
    const valid = verifier.verify(key.pem, parsed.signature, "base64");
    return valid
      ? { ok: true }
      : { ok: false, reason: "invalid", detail: "signature mismatch" };
  } catch (err) {
    // Bad key material behaves like a verification failure, not an outage —
    // a forged kid must not turn into a retriable 5xx loop.
    return {
      ok: false,
      reason: "invalid",
      detail: err instanceof Error ? err.message : "verification error",
    };
  }
}
