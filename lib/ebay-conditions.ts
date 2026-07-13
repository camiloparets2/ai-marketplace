// eBay condition policy math — pure and client-safe, shared by the condition
// dropdown (browser) and the publish chain (server). The network half
// (Sell Metadata getItemConditionPolicies) lives in lib/platforms/ebay.ts,
// aggregated through lib/platforms/ebay-category-policies.ts.
//
// THE BUG THIS PREVENTS: our 5-point grade scale was hardcoded to eBay
// enums (Good → USED_GOOD), but USED_GOOD/USED_ACCEPTABLE (ids 5000/6000)
// are only legal in media-style categories. Home & Garden and most others
// accept only NEW/NEW_OTHER/USED (1000/1500/3000) and reject the rest with
// 400 "The provided condition id is invalid for the selected primary
// category id." Conditions must be resolved PER CATEGORY, like aspects and
// shipping services.

import type { ListingInput } from "@/lib/platforms/types";

export type ConditionGrade = ListingInput["condition"];

// Inventory API ConditionEnum ↔ eBay numeric condition id
// (https://developer.ebay.com/api-docs/sell/inventory/types/slr:ConditionEnum).
export const CONDITION_ID_TO_ENUM: Record<string, string> = {
  "1000": "NEW",
  "1500": "NEW_OTHER",
  "1750": "NEW_WITH_DEFECTS",
  "2000": "CERTIFIED_REFURBISHED",
  "2500": "SELLER_REFURBISHED",
  "2750": "LIKE_NEW",
  "3000": "USED_EXCELLENT", // displays as plain "Used" in most categories
  "4000": "USED_VERY_GOOD",
  "5000": "USED_GOOD",
  "6000": "USED_ACCEPTABLE",
  "7000": "FOR_PARTS_OR_NOT_WORKING",
};

// Buyer-facing wording for the loud "this category can't take that
// condition" messages.
export const CONDITION_ID_LABELS: Record<string, string> = {
  "1000": "New",
  "1500": "New (other)",
  "1750": "New with defects",
  "2000": "Certified refurbished",
  "2500": "Seller refurbished",
  "2750": "Like New",
  "3000": "Used",
  "4000": "Used - Very Good",
  "5000": "Used - Good",
  "6000": "Used - Acceptable",
  "7000": "For parts / not working",
};

// Per grade: condition ids we are WILLING to list under, most-specific
// first. Honesty rule: a fallback may only make the SAME or a MORE GENERIC/
// WORSE claim than the grade — never a better one (no "Acceptable" item
// listed as Like New). Id 3000 is the neutral generic "Used" accepted by
// most categories, so every used grade ends there. Refurbished ids are
// never auto-mapped — that's a legal claim only the seller can make.
export const GRADE_CONDITION_PREFERENCES: Record<ConditionGrade, string[]> = {
  New: ["1000", "1500"],
  "Like New": ["2750", "3000"],
  "Very Good": ["4000", "3000"],
  Good: ["5000", "3000"],
  Acceptable: ["6000", "3000"],
};

/**
 * The condition id to list this grade under, given the category's allowed
 * ids. `allowedIds === null` → policy unknown (metadata unavailable): fall
 * back to the grade's primary id, i.e. the pre-policy behaviour, and let the
 * publish-time guard surface eBay's verbatim rejection if it disagrees.
 * Returns null when the category accepts NONE of the grade's ids — the
 * seller must pick a different condition (the UI disables such grades).
 */
export function nearestAllowedConditionId(
  grade: ConditionGrade,
  allowedIds: string[] | null
): string | null {
  const preferences = GRADE_CONDITION_PREFERENCES[grade];
  if (allowedIds === null) return preferences[0];
  const allowed = new Set(allowedIds);
  return preferences.find((id) => allowed.has(id)) ?? null;
}

/** Inventory API enum for a condition id; null for ids we never emit. */
export function conditionEnumForId(id: string): string | null {
  return CONDITION_ID_TO_ENUM[id] ?? null;
}

/** Grades the category can legally take — drives the condition dropdown. */
export function allowedGrades(
  allowedIds: string[] | null
): ConditionGrade[] {
  const grades = Object.keys(GRADE_CONDITION_PREFERENCES) as ConditionGrade[];
  return grades.filter(
    (grade) => nearestAllowedConditionId(grade, allowedIds) !== null
  );
}

/** Human list of what the category accepts, for loud error/UI copy. */
export function describeAllowedConditions(allowedIds: string[]): string {
  return allowedIds
    .map((id) => CONDITION_ID_LABELS[id] ?? `condition ${id}`)
    .join(", ");
}
