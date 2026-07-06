// Photo hosting for marketplace publishing.
//
// eBay's Inventory API only accepts image *URLs* (no binary upload), so the
// listing photo must live at a public URL before we can publish. We host it
// in a public Supabase Storage bucket. Etsy accepts binary uploads directly,
// so it doesn't need this — but the hosted URL is also handy for the
// Facebook/OfferUp assist flow.

import { getSupabaseAdmin } from "@/lib/connections";
import type { AcceptedMimeType } from "@/lib/image-validation";

const BUCKET = "listing-photos";

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
