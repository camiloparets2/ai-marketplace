// The eBay ENVIRONMENT this process talks to — the isolation dimension for
// every row that stores marketplace state (docs: sandbox + production share
// one Supabase DB; without this, connecting the sandbox seller OVERWROTE the
// production eBay connection, and production then presented a sandbox
// refresh token to the production client → 400 invalid_grant).
//
// Matches apiBase()/resolvePublishMode: sandbox iff EBAY_ENV=sandbox
// (case-insensitive); anything else — including unset — is production.
// Pure and dependency-free (client-safe, though only server code needs it).

export type EbayEnvironment = "production" | "sandbox";

export function currentEbayEnvironment(
  env: Record<string, string | undefined> = process.env
): EbayEnvironment {
  return (env.EBAY_ENV ?? "").toLowerCase() === "sandbox"
    ? "sandbox"
    : "production";
}
