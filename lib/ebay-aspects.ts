// eBay item-aspect (item specifics) helpers — pure and client-safe, shared by
// the draft-edit form (browser) and the publish chain (server). The network
// half (getItemAspectsForCategory / category suggestions) lives in
// lib/platforms/ebay.ts; this module owns the shapes and the completeness
// math so both sides agree on what "ready to publish" means.

// Reserved spec keys carry app metadata on the draft's `specs` jsonb (e.g.
// the seller-chosen eBay category). They are NEVER sent to eBay as aspects —
// buildEbayInventoryItemPayload filters them out.
export const EBAY_CATEGORY_SPEC_KEY = "__ebayCategoryId";
export const EBAY_CATEGORY_NAME_SPEC_KEY = "__ebayCategoryName";

export function isReservedSpecKey(key: string): boolean {
  return key.startsWith("__");
}

// One aspect from getItemAspectsForCategory, reduced to what the form and
// the publish gate need.
export interface AspectField {
  // Localized aspect name, e.g. "Type", "Item Height" — doubles as the spec
  // key the value is stored under.
  name: string;
  // eBay REQUIRES this aspect in the item's category — publish blocks
  // without it.
  required: boolean;
  // aspectUsage === "RECOMMENDED" (search/placement boost; often
  // "required soon"). Rendered as the optional section of the form.
  recommended: boolean;
  // SELECTION_ONLY → closed enum (render a <select> of `values`);
  // FREE_TEXT → open entry (values, when present, are suggestions).
  mode: "SELECTION_ONLY" | "FREE_TEXT";
  // eBay's aspectDataType (STRING, NUMBER, DATE, …) — NUMBER gets a numeric
  // keyboard in the form.
  dataType: string;
  values: string[];
}

// A category candidate for the picker (from get_category_suggestions).
export interface CategoryOption {
  categoryId: string;
  categoryName: string;
}

// How the form should render one aspect: closed enum → select; NUMBER →
// numeric input; everything else free text.
export function aspectInputKind(
  field: AspectField
): "select" | "number" | "text" {
  if (field.mode === "SELECTION_ONLY" && field.values.length > 0) {
    return "select";
  }
  return field.dataType === "NUMBER" ? "number" : "text";
}

// Dimension-ish aspects ("Item Height", "Item Weight", …) want a unit in the
// value ("12 in"); surface that as a placeholder hint in the form.
export function aspectPlaceholder(field: AspectField): string {
  if (/height|length|width|depth/i.test(field.name)) return "e.g. 12 in";
  if (/weight/i.test(field.name)) return "e.g. 2.5 lbs";
  return field.values[0] ? `e.g. ${field.values[0]}` : "";
}

/**
 * Required aspects that still have NO non-empty value. `values` is the
 * merged view of the draft: stored specs plus Brand/Model from the item's
 * own columns (they become aspects at publish time). Key match is
 * case-insensitive, mirroring the publish-time guard
 * (lib/platforms/ebay.ts missingRequiredAspects).
 */
export function missingRequiredAspectValues(
  fields: AspectField[],
  values: Record<string, string>
): string[] {
  const present = new Set(
    Object.entries(values)
      .filter(([key, value]) => !isReservedSpecKey(key) && value.trim() !== "")
      .map(([key]) => key.toLowerCase())
  );
  return fields
    .filter((f) => f.required && !present.has(f.name.toLowerCase()))
    .map((f) => f.name);
}
