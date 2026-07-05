// Safe handling of ?next= redirect targets in auth flows.
//
// Auth callbacks and the login page accept a `next` query param saying where
// to land after sign-in. Left unvalidated, that's an open-redirect vector
// (e.g. ?next=https://evil.example or ?next=//evil.example). Only same-origin
// absolute paths are allowed; anything else falls back to "/".

export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  // Must be an absolute path within this origin:
  //   "/"      → allowed
  //   "/reset-password" → allowed
  //   "//evil.example"  → protocol-relative URL, rejected
  //   "https://evil.example" → rejected
  //   "/\evil.example"  → browsers normalise \ to /, rejected
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  if (next.includes("\\")) return "/";
  return next;
}
