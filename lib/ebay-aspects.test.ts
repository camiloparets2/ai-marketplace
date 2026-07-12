// Pure item-specifics helpers: the enum-vs-freetext form branch and the
// completeness math the publish button gates on (mirrors the server-side
// missingRequiredAspects guard).

import { describe, it, expect } from "vitest";
import {
  aspectInputKind,
  aspectPlaceholder,
  missingRequiredAspectValues,
  isReservedSpecKey,
  EBAY_CATEGORY_SPEC_KEY,
} from "./ebay-aspects";
import type { AspectField } from "./ebay-aspects";

function field(over: Partial<AspectField>): AspectField {
  return {
    name: "Type",
    required: true,
    recommended: false,
    mode: "FREE_TEXT",
    dataType: "STRING",
    values: [],
    ...over,
  };
}

describe("aspectInputKind — enum vs free text vs number", () => {
  it("closed enums (SELECTION_ONLY with values) render a select", () => {
    expect(
      aspectInputKind(
        field({ mode: "SELECTION_ONLY", values: ["Over-Ear", "In-Ear"] })
      )
    ).toBe("select");
  });

  it("SELECTION_ONLY with no values falls back to free text", () => {
    expect(aspectInputKind(field({ mode: "SELECTION_ONLY", values: [] }))).toBe(
      "text"
    );
  });

  it("NUMBER data type gets a numeric input", () => {
    expect(
      aspectInputKind(field({ dataType: "NUMBER", name: "Item Height" }))
    ).toBe("number");
  });

  it("plain free text stays text", () => {
    expect(aspectInputKind(field({}))).toBe("text");
  });
});

describe("aspectPlaceholder", () => {
  it("hints a unit for dimension and weight aspects", () => {
    expect(aspectPlaceholder(field({ name: "Item Height" }))).toMatch(/in/);
    expect(aspectPlaceholder(field({ name: "Item Weight" }))).toMatch(/lbs/);
  });
  it("suggests eBay's first value otherwise", () => {
    expect(aspectPlaceholder(field({ values: ["Solid"] }))).toBe("e.g. Solid");
  });
});

describe("missingRequiredAspectValues — publish blocked until complete", () => {
  const fields = [
    field({ name: "Type", required: true }),
    field({ name: "Item Height", required: true, dataType: "NUMBER" }),
    field({ name: "Brand", required: true }),
    field({ name: "Pattern", required: false, recommended: true }),
  ];

  it("reports every required aspect with no value", () => {
    expect(missingRequiredAspectValues(fields, {})).toEqual([
      "Type",
      "Item Height",
      "Brand",
    ]);
  });

  it("empty and whitespace values still count as missing", () => {
    expect(
      missingRequiredAspectValues(fields, {
        Type: "",
        "Item Height": "   ",
        Brand: "Sony",
      })
    ).toEqual(["Type", "Item Height"]);
  });

  it("matches keys case-insensitively (extraction 'type' satisfies 'Type')", () => {
    expect(
      missingRequiredAspectValues(fields, {
        type: "Over-Ear",
        "item height": "8 in",
        Brand: "Sony",
      })
    ).toEqual([]);
  });

  it("optional/recommended aspects never block", () => {
    expect(
      missingRequiredAspectValues(fields, {
        Type: "Over-Ear",
        "Item Height": "8 in",
        Brand: "Sony",
      })
    ).toEqual([]);
  });

  it("reserved __keys are metadata, not aspect values", () => {
    expect(isReservedSpecKey(EBAY_CATEGORY_SPEC_KEY)).toBe(true);
    expect(
      missingRequiredAspectValues(
        [field({ name: EBAY_CATEGORY_SPEC_KEY.slice(2), required: true })],
        { [EBAY_CATEGORY_SPEC_KEY]: "12345" }
      )
    ).toHaveLength(1);
  });
});
