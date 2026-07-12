// Shipping service identifiers — snake_case so they work as object keys and map cleanly
// to platform-specific codes in Phase 2 (eBay: 'USPSPriority', Etsy: 'usps_first_class_mail').
// Display names live in SHIPPING_DISPLAY_NAMES, not here.
export type ShippingService =
  | "USPS_FLAT_RATE_SMALL"
  | "USPS_FLAT_RATE_MEDIUM"
  | "USPS_FLAT_RATE_LARGE"
  | "MANUAL_ESTIMATE_NEEDED";

// Human-readable display strings kept separate from identifiers.
export const SHIPPING_DISPLAY_NAMES: Record<ShippingService, string> = {
  USPS_FLAT_RATE_SMALL: "USPS Flat Rate Small ($10.40)",
  USPS_FLAT_RATE_MEDIUM: "USPS Flat Rate Medium ($16.10)",
  USPS_FLAT_RATE_LARGE: "USPS Flat Rate Large ($22.45)",
  MANUAL_ESTIMATE_NEEDED: "Manual estimate needed",
};

// Structured data returned by the Claude Vision extraction engine.
// Every field is either a concrete value or null — no undefined, no optional fields.
// The confidence map keys are constrained to actual ExtractionResult field names,
// preventing typos that would silently hide the "needs review" indicator in the UI.
// Where a brand claim came from. Only READABLE sources (a tag/label, or a
// printed logo cross-checked against known brands) survive the brand guard
// in lib/ai/brand-guard.ts — styling-based inference never does.
export type BrandSource = "tag_or_label" | "logo" | "inferred" | "none";

export interface ExtractionResult {
  title: string;
  brand: string | null;
  // How the brand was determined — feeds the brand-hallucination guard.
  brandSource: BrandSource;
  model: string | null;
  // UPC extracted via OCR from visible barcode or label text.
  upc: string | null;
  condition: "New" | "Like New" | "Very Good" | "Good" | "Acceptable";
  // Visible flaws that justify the condition grade (scratches, missing parts,
  // stains, cracked screen…). Empty when nothing is visibly wrong. Buyers see
  // honest defect lists; sellers avoid INAD returns.
  defects: string[];
  // eBay-style category path, e.g. "Electronics > Headphones"
  category: string;
  // Channel-routing signals (Etsy only allows handmade / vintage 20+yr /
  // craft supplies — see lib/routing.ts):
  // The item appears handmade/artisan rather than mass-produced.
  handmade: boolean;
  // Approximate year of manufacture when inferable (vintage detection), else null.
  estimatedYearMade: number | null;
  // The item is a supply used to MAKE things (yarn, beads, fabric, tools-for-craft).
  craftSupply: boolean;
  // Aspect-mapped fields — each corresponds to a high-frequency eBay item
  // aspect (getItemAspectsForCategory): Material, Color, Size, Style,
  // Pattern. Folded into `specs` under those aspect names by
  // foldAspectsIntoSpecs, so they flow to item specifics AND tighten comps
  // queries with no extra plumbing. All null when not visible.
  material: string | null;
  colorPrimary: string | null;
  colorSecondary: string | null;
  size: string | null;
  // The sizing standard the size is expressed in, when determinable.
  sizeSystem: "US" | "UK" | "EU" | null;
  style: string | null;
  pattern: string | null;
  // Open-ended key-value spec pairs (wattage, color, size, material, etc.).
  // In Phase 2 these will be mapped to eBay/Etsy item specifics schemas.
  specs: Record<string, string>;
  estimatedDimensions: {
    lengthIn: number;
    widthIn: number;
    heightIn: number;
  } | null;
  estimatedWeightLbs: number | null;
  // Which USPS Flat Rate box the item fits in, based on estimated dimensions.
  // MANUAL_ESTIMATE_NEEDED fires when confidence is too low OR when the item
  // doesn't fit any flat rate box — treat these as distinct UX cases in the UI.
  suggestedShippingService: ShippingService;
  // Dollar amount from the flat rate lookup table, or null when MANUAL_ESTIMATE_NEEDED.
  estimatedShippingCost: number | null;
  // AI-recommended asking price in dollars — pre-fills the EDITABLE price
  // field in the review UI. Regression note: dropped by the vision.ts
  // refactor (e548dab) and restored per docs/design/ship-from-location.md.
  // Null only when the item is truly unpriceable; uncertainty belongs in a
  // lower confidence score, not a missing price.
  suggestedPrice: number | null;
  // 1-2 sentence rationale for the price, e.g. "Used WH-1000XM4 in Good
  // condition sells for $150-180; $165 targets a one-week sale." Null when
  // suggestedPrice is null.
  priceRationale: string | null;
  // Per-field confidence scores from 0–100. Only keys that Claude populated are present.
  // UI renders a yellow "needs review" indicator when confidence[field] < CONFIDENCE_THRESHOLD.
  // NOTE (Phase 2 TODO): Claude generates confidence scores in the same inference pass as
  // the values — validate calibration against the Phase 1 Google Sheet data before trusting
  // the threshold. See TODOS.md.
  confidence: Partial<
    Record<keyof Omit<ExtractionResult, "confidence">, number>
  >;
}

// Fields below this threshold get a yellow "needs review" indicator.
export const CONFIDENCE_THRESHOLD = 60;

// Fields that are critical for INAD (Item Not As Described) returns.
// When any of these are below threshold, warn the user explicitly.
export const CRITICAL_FIELDS: ReadonlyArray<
  keyof Omit<ExtractionResult, "confidence">
> = ["title", "category", "suggestedShippingService"];

// The tool schema passed to Claude's tool_use call.
// Kept co-located with the type so schema and interface stay in sync.
export const EXTRACTION_TOOL_SCHEMA = {
  name: "extract_listing",
  description:
    "Extract structured product listing data from the provided product photo.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "Concise product title suitable for a marketplace listing",
      },
      brand: {
        type: ["string", "null"],
        description:
          "Brand name ONLY if actually readable in the photo (on a tag, label, or printed logo). NEVER infer a brand from styling, shape, or quality — null when no brand text is readable.",
      },
      brandSource: {
        type: "string",
        enum: ["tag_or_label", "logo", "inferred", "none"],
        description:
          "Where the brand was read: 'tag_or_label' when readable on a sewn tag, sticker, or product label; 'logo' when readable as a printed/embossed logo on the item; 'inferred' if you guessed from styling (avoid); 'none' when brand is null.",
      },
      model: {
        type: ["string", "null"],
        description: "Model name or number, null if not visible",
      },
      upc: {
        type: ["string", "null"],
        description:
          "UPC barcode value read via OCR from barcode or label, null if not visible",
      },
      condition: {
        type: "string",
        enum: ["New", "Like New", "Very Good", "Good", "Acceptable"],
        description: "Condition assessment based on visible wear",
      },
      defects: {
        type: "array",
        items: { type: "string" },
        description:
          "Every visible flaw: scratches, dents, stains, missing parts, damage. Empty array when the item looks flawless.",
      },
      category: {
        type: "string",
        description:
          "eBay-style category path, e.g. 'Electronics > Headphones'",
      },
      handmade: {
        type: "boolean",
        description:
          "True only when the item is clearly handmade/artisan rather than mass-produced",
      },
      estimatedYearMade: {
        type: ["number", "null"],
        description:
          "Approximate year of manufacture when inferable from styling, labels, or model history; null when unknown",
      },
      craftSupply: {
        type: "boolean",
        description:
          "True when the item is a supply used to make things (yarn, beads, fabric, leather blanks, craft tools)",
      },
      material: {
        type: ["string", "null"],
        description:
          "Primary material when visible or labeled (e.g. 'Leather', 'Cotton', 'Stainless Steel'), null if not determinable",
      },
      colorPrimary: {
        type: ["string", "null"],
        description: "Dominant color of the item, null if not determinable",
      },
      colorSecondary: {
        type: ["string", "null"],
        description:
          "Secondary/accent color when clearly present, null otherwise",
      },
      size: {
        type: ["string", "null"],
        description:
          "Size as printed on tag/label (e.g. 'M', '10.5', '32x34'), null when no size is readable",
      },
      sizeSystem: {
        type: ["string", "null"],
        enum: ["US", "UK", "EU", null],
        description:
          "The sizing standard the size uses when determinable from the tag, null otherwise",
      },
      style: {
        type: ["string", "null"],
        description:
          "Style descriptor buyers filter by (e.g. 'Crewneck', 'Chelsea Boot', 'Mid-Century'), null if not applicable",
      },
      pattern: {
        type: ["string", "null"],
        description:
          "Visible pattern (e.g. 'Striped', 'Floral', 'Solid'), null if not determinable",
      },
      specs: {
        type: "object",
        description:
          "Key-value pairs of product specifications visible in the photo",
        additionalProperties: { type: "string" },
      },
      estimatedDimensions: {
        oneOf: [
          {
            type: "object",
            properties: {
              lengthIn: { type: "number" },
              widthIn: { type: "number" },
              heightIn: { type: "number" },
            },
            required: ["lengthIn", "widthIn", "heightIn"],
          },
          { type: "null" },
        ],
        description:
          "Estimated physical dimensions in inches based on visual cues, null if cannot estimate",
      },
      estimatedWeightLbs: {
        type: ["number", "null"],
        description: "Estimated weight in pounds, null if cannot estimate",
      },
      suggestedShippingService: {
        type: "string",
        enum: [
          "USPS_FLAT_RATE_SMALL",
          "USPS_FLAT_RATE_MEDIUM",
          "USPS_FLAT_RATE_LARGE",
          "MANUAL_ESTIMATE_NEEDED",
        ],
        description:
          "Which USPS Flat Rate box the item fits in based on estimated dimensions. Use MANUAL_ESTIMATE_NEEDED when dimensions are uncertain or the item is too large for flat rate.",
      },
      estimatedShippingCost: {
        type: ["number", "null"],
        description:
          "Estimated shipping cost in dollars from the flat rate table, null when MANUAL_ESTIMATE_NEEDED",
      },
      suggestedPrice: {
        type: ["number", "null"],
        description:
          "Recommended asking price in dollars based on the item's identity, condition, and typical resale market value. Always suggest a price — express uncertainty through a lower confidence score, not by omitting it. Null only when the item is truly unpriceable.",
      },
      priceRationale: {
        type: ["string", "null"],
        description:
          "1-2 sentences explaining your price. Cite the comparable market (e.g. 'Used Sony WH-1000XM4 in Good condition sells for $150-180 on eBay. $165 targets a quick sale.'). Null when suggestedPrice is null.",
      },
      confidence: {
        type: "object",
        description:
          "Confidence score 0–100 for each field you populated. Only include fields you actually extracted.",
        additionalProperties: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    required: [
      "title",
      "brand",
      "brandSource",
      "model",
      "upc",
      "condition",
      "defects",
      "category",
      "handmade",
      "estimatedYearMade",
      "craftSupply",
      "material",
      "colorPrimary",
      "colorSecondary",
      "size",
      "sizeSystem",
      "style",
      "pattern",
      "specs",
      "estimatedDimensions",
      "estimatedWeightLbs",
      "suggestedShippingService",
      "estimatedShippingCost",
      "suggestedPrice",
      "priceRationale",
      "confidence",
    ],
  },
} as const;
