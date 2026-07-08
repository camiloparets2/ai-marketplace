#!/usr/bin/env node
// Smoke test: mint an eBay application token via the client-credentials
// grant to prove the keyset + secret path end-to-end.
//
//   npm run smoke:ebay
//
// Reads EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_ENV from the environment
// (source .env.local first, e.g. `set -a; . ./.env.local; set +a`).
// Skips gracefully when credentials aren't set. Never prints secrets or the
// minted token.

const clientId = process.env.EBAY_CLIENT_ID;
const clientSecret = process.env.EBAY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.log(
    "SKIP: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set — nothing to smoke test."
  );
  process.exit(0);
}

const isSandbox = (process.env.EBAY_ENV ?? "production").toLowerCase() === "sandbox";
const tokenUrl = isSandbox
  ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
  : "https://api.ebay.com/identity/v1/oauth2/token";

console.log(`Minting application token against ${isSandbox ? "SANDBOX" : "PRODUCTION"}…`);

const res = await fetch(tokenUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
  },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  }).toString(),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`FAIL: ${res.status} ${res.statusText}`);
  // eBay error bodies don't contain the secret; safe to show for diagnosis.
  console.error(body);
  console.error(
    isSandbox
      ? "Hint: the sandbox Cert ID was rotated 2026-07-04 — is EBAY_CLIENT_SECRET the NEW sandbox secret?"
      : "Hint: is EBAY_CLIENT_SECRET the PRODUCTION Cert ID matching this App ID?"
  );
  process.exit(1);
}

const token = await res.json();
console.log(
  `OK: application token minted (type=${token.token_type}, expires_in=${token.expires_in}s). Token value not shown.`
);
