// Friendly mapping for Supabase Auth error messages.
//
// Supabase surfaces raw provider/config errors (e.g. "Unsupported provider:
// provider is not enabled") that are meaningless to a seller. This maps the
// known config-failure cases to actionable copy while leaving every other
// message untouched — so real, user-fixable errors (wrong password, etc.)
// still surface verbatim.

// A provider isn't turned on in the Supabase dashboard, or the anon key /
// project is misconfigured. These are operator problems, not user problems.
const CONFIG_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /provider is not enabled/i,
  /unsupported provider/i,
  /invalid api key/i,
  /provider.*disabled/i,
];

export const GOOGLE_NOT_ENABLED_MESSAGE =
  "Google sign-in isn't enabled yet — use email, or contact support.";

/**
 * Map a raw Supabase auth error message to something a seller can act on.
 * Unknown messages pass through unchanged (never hide a real error).
 *
 * @param provider optional label so the message can name the provider.
 */
export function friendlyAuthError(
  rawMessage: string,
  provider?: "google"
): string {
  if (rawMessage === "auth_unavailable") {
    return "Sign-in is temporarily unavailable. Please wait a moment and try again.";
  }
  if (CONFIG_ERROR_PATTERNS.some((p) => p.test(rawMessage))) {
    return provider === "google"
      ? GOOGLE_NOT_ENABLED_MESSAGE
      : "Sign-in isn't fully configured yet — use email, or contact support.";
  }
  return rawMessage;
}
