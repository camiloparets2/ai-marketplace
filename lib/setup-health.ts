// Deployment setup assertions (server-only) — the checks that catch a
// misconfigured project BEFORE a seller pays for it with a broken publish.
//
// First assertion (fix/draft-publish-and-credits, Part 3): the listing-photo
// bucket must be PUBLIC. lib/storage.ts getPublicUrl() builds the
// /object/public/… URL string unconditionally, so a private bucket makes
// every stored photo URL a dead 400/503 link — production photos were doing
// exactly that. The publish path has its own per-URL preflight
// (assertPhotosPubliclyReachable); this is the setup-level probe that names
// the root cause.

import { getSupabaseAdmin } from "@/lib/connections";
import { LISTING_PHOTO_BUCKET } from "@/lib/storage";

export interface SetupCheck {
  name: string;
  ok: boolean;
  // Human-readable state; when ok is false this states the exact fix.
  detail: string;
}

export async function checkListingPhotoBucket(): Promise<SetupCheck> {
  const name = "listing_photo_bucket_public";
  try {
    const { data, error } = await getSupabaseAdmin().storage.getBucket(
      LISTING_PHOTO_BUCKET
    );
    if (error || !data) {
      return {
        name,
        ok: false,
        detail: `Bucket "${LISTING_PHOTO_BUCKET}" not found (${error?.message ?? "no data"}) — it is created on the first photo upload, or create it manually in Supabase Storage (public).`,
      };
    }
    if (!data.public) {
      return {
        name,
        ok: false,
        detail: `Bucket "${LISTING_PHOTO_BUCKET}" is PRIVATE — every stored photo URL is a dead link and eBay publishes will fail their photo preflight. Flip the bucket to public in Supabase Storage.`,
      };
    }
    return {
      name,
      ok: true,
      detail: `Bucket "${LISTING_PHOTO_BUCKET}" exists and is public.`,
    };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: `Bucket check failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** All setup assertions. Extend as new deploy-time invariants appear. */
export async function runSetupChecks(): Promise<SetupCheck[]> {
  return [await checkListingPhotoBucket()];
}
