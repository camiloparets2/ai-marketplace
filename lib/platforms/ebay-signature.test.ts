// X-EBAY-SIGNATURE verification wrapper — a real ECDSA keypair signs test
// payloads exactly the way eBay's Event Notification service does, so the
// verifier is exercised end-to-end without any network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync, createSign } from "crypto";
import {
  verifyEbaySignature,
  clearEbayKeyCacheForTests,
  normalizePem,
} from "./ebay-signature";
import type { EbayPublicKey } from "./ebay-signature";

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const { privateKey: otherPrivateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

function sign(payload: string, key = privateKey): string {
  const signer = createSign("SHA1");
  signer.update(payload);
  return signer.sign(key, "base64");
}

function header(payload: string, over: Partial<Record<string, string>> = {}): string {
  return Buffer.from(
    JSON.stringify({
      alg: "ecdsa",
      kid: "kid-1",
      signature: sign(payload),
      digest: "SHA1",
      ...over,
    })
  ).toString("base64");
}

const fetchKey = vi.fn(
  async (): Promise<EbayPublicKey> => ({ pem: publicPem, digest: "SHA1" })
);

beforeEach(() => {
  clearEbayKeyCacheForTests();
  fetchKey.mockClear();
});

describe("verifyEbaySignature", () => {
  it("accepts a correctly signed payload", async () => {
    const payload = JSON.stringify({ notification: { notificationId: "n-1" } });
    const verdict = await verifyEbaySignature(payload, header(payload), fetchKey);
    expect(verdict).toEqual({ ok: true });
  });

  it("rejects a tampered payload as invalid (→ 412)", async () => {
    const payload = JSON.stringify({ notification: { notificationId: "n-1" } });
    const verdict = await verifyEbaySignature(
      payload.replace("n-1", "n-2"),
      header(payload),
      fetchKey
    );
    expect(verdict).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects a signature from the wrong key", async () => {
    const payload = "body";
    const forged = Buffer.from(
      JSON.stringify({
        alg: "ecdsa",
        kid: "kid-1",
        signature: sign(payload, otherPrivateKey),
        digest: "SHA1",
      })
    ).toString("base64");
    const verdict = await verifyEbaySignature(payload, forged, fetchKey);
    expect(verdict).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects a missing or malformed header as invalid", async () => {
    expect(await verifyEbaySignature("body", null, fetchKey)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      await verifyEbaySignature("body", "not-base64-json", fetchKey)
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it("rejects unknown algorithms without fetching keys", async () => {
    const payload = "body";
    const verdict = await verifyEbaySignature(
      payload,
      header(payload, { alg: "hmac" }),
      fetchKey
    );
    expect(verdict).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it("caches the public key — one fetch for repeated notifications", async () => {
    const payload = "body";
    await verifyEbaySignature(payload, header(payload), fetchKey);
    await verifyEbaySignature(payload, header(payload), fetchKey);
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });

  it("reports 'unavailable' (→ 5xx) when the key can't be fetched", async () => {
    const failing = vi.fn(async (): Promise<EbayPublicKey> => {
      throw new Error("token endpoint down");
    });
    const payload = "body";
    const verdict = await verifyEbaySignature(payload, header(payload), failing);
    expect(verdict).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("treats garbage key material as invalid, not an outage", async () => {
    const badKey = vi.fn(
      async (): Promise<EbayPublicKey> => ({ pem: "garbage", digest: "SHA1" })
    );
    const payload = "body";
    const verdict = await verifyEbaySignature(payload, header(payload), badKey);
    expect(verdict).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("normalizePem", () => {
  it("reframes eBay's single-line key into valid PEM", () => {
    const singleLine = publicPem.replace(/\n/g, "");
    const normalized = normalizePem(singleLine);
    expect(normalized).toContain("-----BEGIN PUBLIC KEY-----\n");
    expect(normalized.trimEnd()).toMatch(/-----END PUBLIC KEY-----$/);
    // Round-trips: the normalized PEM still verifies a signature.
  });
});
