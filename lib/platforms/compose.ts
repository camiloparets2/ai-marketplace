import type {
  ComposedListing,
  ListingInput,
  Platform,
} from "@/lib/platforms/types";

// ─── Platform constraints ─────────────────────────────────────────────────────
// Title limits per platform (characters). Sources: eBay listing policy (80),
// Etsy listing schema (140), Facebook Marketplace UI (99), OfferUp UI (~80).

export const TITLE_LIMITS: Record<Platform, number> = {
  ebay: 80,
  etsy: 140,
  facebook: 99,
  offerup: 80,
};

// Etsy allows at most 13 tags, each ≤ 20 characters.
export const ETSY_MAX_TAGS = 13;
export const ETSY_TAG_MAX_LENGTH = 20;

// ─── Condition mappings ───────────────────────────────────────────────────────

// eBay Inventory API condition enums.
// https://developer.ebay.com/api-docs/sell/inventory/types/slr:ConditionEnum
export const EBAY_CONDITION_MAP: Record<ListingInput["condition"], string> = {
  New: "NEW",
  "Like New": "LIKE_NEW",
  "Very Good": "USED_VERY_GOOD",
  Good: "USED_GOOD",
  Acceptable: "USED_ACCEPTABLE",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Truncate on a word boundary where possible so titles never end mid-word.
export function truncateTitle(title: string, limit: number): string {
  const trimmed = title.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  // Only respect the word boundary when it doesn't cost more than 15 chars.
  return (lastSpace > limit - 15 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

// Derive Etsy tags from brand/model/category/specs. Tags must be ≤ 20 chars;
// longer candidates are dropped rather than truncated (a cut-off tag is noise).
export function buildEtsyTags(input: ListingInput): string[] {
  const candidates: string[] = [];

  if (input.brand) candidates.push(input.brand);
  if (input.model) candidates.push(input.model);

  // "Electronics > Headphones" → ["Electronics", "Headphones"]
  for (const segment of input.category.split(">")) {
    candidates.push(segment.trim());
  }

  for (const [key, value] of Object.entries(input.specs)) {
    candidates.push(value);
    candidates.push(key);
  }

  candidates.push(input.condition);

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of candidates) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || tag.length > ETSY_TAG_MAX_LENGTH || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= ETSY_MAX_TAGS) break;
  }
  return tags;
}

// ─── Description builders ─────────────────────────────────────────────────────

function specLines(input: ListingInput): string[] {
  const lines: string[] = [];
  if (input.brand) lines.push(`Brand: ${input.brand}`);
  if (input.model) lines.push(`Model: ${input.model}`);
  if (input.upc) lines.push(`UPC: ${input.upc}`);
  lines.push(`Condition: ${input.condition}`);
  for (const [key, value] of Object.entries(input.specs)) {
    lines.push(`${key}: ${value}`);
  }
  return lines;
}

function plainDescription(input: ListingInput): string {
  const shipping =
    input.shippingCost !== null
      ? `Ships via USPS Flat Rate ($${input.shippingCost.toFixed(2)}).`
      : "Shipping calculated at sale.";

  return [
    input.title.trim(),
    "",
    ...specLines(input),
    "",
    shipping,
    "Listed with Snap to List.",
  ].join("\n");
}

// eBay accepts simple HTML in listing descriptions; everything else gets plain text.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function ebayHtmlDescription(input: ListingInput): string {
  const items = specLines(input)
    .map((l) => `<li>${escapeHtml(l)}</li>`)
    .join("");
  return `<p>${escapeHtml(input.title.trim())}</p><ul>${items}</ul>`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function composeListing(
  platform: Platform,
  input: ListingInput
): ComposedListing {
  return {
    platform,
    title: truncateTitle(input.title, TITLE_LIMITS[platform]),
    description: plainDescription(input),
    tags: platform === "etsy" ? buildEtsyTags(input) : [],
  };
}

// The clipboard payload for assist platforms (Facebook Marketplace, OfferUp):
// title, price, and description in the order their create-listing forms ask.
export function assistCopyText(
  platform: Platform,
  input: ListingInput
): string {
  const composed = composeListing(platform, input);
  return [
    composed.title,
    `$${input.price.toFixed(2)}`,
    "",
    composed.description,
  ].join("\n");
}
