// Photo hosting for marketplace publishing.
//
// eBay's Inventory API only accepts image *URLs* (no binary upload), so the
// listing photo must live at a public URL before we can publish. We host it
// in a public Supabase Storage bucket. Etsy accepts binary uploads directly,
// so it doesn't need this — but the hosted URL is also handy for the
// Facebook/OfferUp assist flow.

import { getSupabaseAdmin } from "@/lib/connections";
import type { AcceptedMimeType } from "@/lib/image-validation";

export const LISTING_PHOTO_BUCKET = "listing-photos";
const BUCKET = LISTING_PHOTO_BUCKET;

const EXTENSION: Record<AcceptedMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Uploads the listing photo and returns its public URL.
// Creates the bucket on first use so no manual Supabase setup is required.
export async function hostListingPhoto(
  bytes: Uint8Array,
  mimeType: AcceptedMimeType
): Promise<string> {
  const supabase = getSupabaseAdmin();

  // createBucket errors if it already exists — that's the normal steady state.
  await supabase.storage
    .createBucket(BUCKET, { public: true })
    .catch(() => undefined);

  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${EXTENSION[mimeType]}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mimeType });

  if (error) {
    throw new Error(`Photo upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Preflight: verify every listing photo URL is PUBLICLY fetchable before it
 * is sent to a marketplace. getPublicUrl() builds the /object/public/… URL
 * string unconditionally — if the bucket is private the URL is a dead link
 * (HTTP 400/403/503), and eBay would either reject the listing or list it
 * photoless. Fail loudly here, with the fix, instead.
 *
 * HEAD first; a couple of CDN setups reject HEAD (405/501), so fall back to
 * GET before declaring the URL dead.
 */
export async function assertPhotosPubliclyReachable(
  urls: string[]
): Promise<void> {
  await Promise.all(
    urls.map(async (url) => {
      let res = await fetch(url, { method: "HEAD" }).catch(() => null);
      if (res && (res.status === 405 || res.status === 501)) {
        res = await fetch(url).catch(() => null);
      }
      if (!res || !res.ok) {
        const status = res ? ` (HTTP ${res.status})` : "";
        throw new Error(
          `Listing photo isn't publicly reachable${status} — the "${BUCKET}" storage bucket is likely set to private. Make it public in Supabase Storage, then retry. The listing was NOT published without its photo.`
        );
      }
    })
  );
}
