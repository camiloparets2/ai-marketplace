// Category condition policy math (sandbox blocker: "The provided condition
// id is invalid for the selected primary category id"). USED_GOOD /
// USED_ACCEPTABLE are media-only; most categories accept just
// NEW/NEW_OTHER/USED. The mapper picks the nearest condition a category
// ACCEPTS, with honesty-ordered fallbacks — never a better claim than the
// grade.

import { describe, it, expect } from "vitest";
import {
  nearestAllowedConditionId,
  conditionEnumForId,
  allowedGrades,
  describeAllowedConditions,
} from "./ebay-conditions";

// getItemConditionPolicies shapes seen in the wild:
const MEDIA_CATEGORY = ["1000", "1500", "2750", "3000", "4000", "5000", "6000"];
const HOME_AND_GARDEN = ["1000", "1500", "3000"];
const NEW_ONLY = ["1000", "1500"];

describe("nearestAllowedConditionId", () => {
  it("media categories keep the full graded scale (Good stays USED_GOOD)", () => {
    expect(nearestAllowedConditionId("Good", MEDIA_CATEGORY)).toBe("5000");
    expect(conditionEnumForId("5000")).toBe("USED_GOOD");
    expect(nearestAllowedConditionId("Acceptable", MEDIA_CATEGORY)).toBe("6000");
    expect(nearestAllowedConditionId("Very Good", MEDIA_CATEGORY)).toBe("4000");
  });

  it("Home & Garden maps every used grade to generic Used (3000) — never a 400", () => {
    expect(nearestAllowedConditionId("Good", HOME_AND_GARDEN)).toBe("3000");
    expect(conditionEnumForId("3000")).toBe("USED_EXCELLENT");
    expect(nearestAllowedConditionId("Very Good", HOME_AND_GARDEN)).toBe("3000");
    expect(nearestAllowedConditionId("Acceptable", HOME_AND_GARDEN)).toBe("3000");
    expect(nearestAllowedConditionId("Like New", HOME_AND_GARDEN)).toBe("3000");
    expect(nearestAllowedConditionId("New", HOME_AND_GARDEN)).toBe("1000");
  });

  it("never maps a used grade to a NEW claim (honesty rule)", () => {
    // A category that only takes new items: used grades are unmappable —
    // the seller decides, we never upgrade the claim.
    expect(nearestAllowedConditionId("Good", NEW_ONLY)).toBeNull();
    expect(nearestAllowedConditionId("Acceptable", NEW_ONLY)).toBeNull();
    expect(nearestAllowedConditionId("Like New", NEW_ONLY)).toBeNull();
  });

  it("unknown policy (null) falls back to the grade's primary id", () => {
    expect(nearestAllowedConditionId("Good", null)).toBe("5000");
    expect(nearestAllowedConditionId("New", null)).toBe("1000");
  });
});

describe("allowedGrades — the condition dropdown constraint", () => {
  it("only offers grades the category can legally take", () => {
    expect(allowedGrades(NEW_ONLY)).toEqual(["New"]);
    expect(allowedGrades(HOME_AND_GARDEN)).toEqual([
      "New",
      "Like New",
      "Very Good",
      "Good",
      "Acceptable",
    ]);
  });

  it("offers everything when the policy is unknown", () => {
    expect(allowedGrades(null)).toHaveLength(5);
  });
});

describe("describeAllowedConditions", () => {
  it("names conditions in seller language for the loud error", () => {
    expect(describeAllowedConditions(HOME_AND_GARDEN)).toBe(
      "New, New (other), Used"
    );
  });
});
