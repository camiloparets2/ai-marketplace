// The auto-list pipeline (docs/design/launch.md, Phase 1 happy path):
//
//   photo → identify (lib/ai/vision.ts) → persist draft → price (floor +
//   strategy, price_history row) → build eBay payload → publish → record
//   the live listing.
//
// SAFETY: production auto-publish sits behind PIPELINE_LIVE_PUBLISH, which
// ships OFF. With the flag off and EBAY_ENV != sandbox, the publish step is
// a dry run: the exact payload is built and returned, no eBay call happens,
// nothing is written to marketplace_listings. Sandbox publishes are always
// allowed. The user-initiated /api/publish flow is unaffected by this flag.
//
// Every step's dependencies are injectable so tests exercise the real
// orchestration with fakes — no network, no DB.

import { identifyItem } from "@/lib/ai/vision";
import type { IdentifiedItem } from "@/lib/ai/vision";
import { hostListingPhoto } from "@/lib/storage";
import { createDraftItem, setItemPrice, setItemReview, recordLiveListing, markItemListed, recordPublishAttempt, beginPublishAttempt, completePublishAttempt, getItemDetail, approveItemFromReview } from "@/lib/inventory";
import type { DraftItemInput, LiveListing, ItemDetailRow, PublishAttemptCompletion } from "@/lib/inventory";
import { evaluateGuardrails } from "@/lib/guardrails";
import type { GuardrailVerdict } from "@/lib/guardrails";
import { recordAudit } from "@/lib/audit";
import { decidePrice, recordPriceDecision } from "@/lib/pricing";
import type { PriceDecision, PriceRequest } from "@/lib/pricing";
import { fetchEbayComps } from "@/lib/platforms/ebay-comps";
import type { CompsSummary } from "@/lib/comps";
import { publishToEbay, buildEbayInventoryItemPayload, ebaySkuForItem } from "@/lib/platforms/ebay";
import type { EbayPublishResult, EbayInventoryItemPayload } from "@/lib/platforms/ebay";
import { publishToEtsy } from "@/lib/platforms/etsy";
import type { EtsyPublishResult } from "@/lib/platforms/etsy";
import { routeChannels } from "@/lib/routing";
import type { RoutingDecision } from "@/lib/routing";
import { getConnection } from "@/lib/connections";
import type { ListingInput, PlatformConnection } from "@/lib/platforms/types";
import type { AcceptedMimeType } from "@/lib/image-validation";

// ─── Publish mode ─────────────────────────────────────────────────────────────

export type PublishMode = "sandbox" | "live" | "dry_run";

export function resolvePublishMode(
  env: Record<string, string | undefined> = process.env
): PublishMode {
  if ((env.EBAY_ENV ?? "").toLowerCase() === "sandbox") return "sandbox";
  // Production requires the explicit opt-in flag — shipped OFF.
  return env.PIPELINE_LIVE_PUBLISH === "true" ? "live" : "dry_run";
}

// ─── Result contract ──────────────────────────────────────────────────────────

export type PipelinePublishOutcome =
  | {
      mode: PublishMode;
      status: "live";
      url: string;
      listingId: string;
      // The persist-before-publish attempt row for this publish.
      attemptId?: string;
      // True when the listing IS live on eBay but local recording failed —
      // the attempt row carries the ids; do not treat the item as unlisted.
      reconciliationRequired?: boolean;
    }
  | { mode: "dry_run"; status: "dry_run"; payload: EbayInventoryItemPayload }
  | { mode: PublishMode; status: "not_connected"; connectUrl: string }
  | { mode: PublishMode; status: "error"; message: string; attemptId?: string }
  // A guardrail failed — the item is parked in the review queue, unpublished.
  | {
      mode: PublishMode;
      status: "review";
      failures: Array<{ gate: string; reason: string }>;
    };

// The optional Etsy leg (routing table P1-1). Etsy has no sandbox, so it
// only actually publishes in live mode; otherwise it reports why it didn't.
export type EtsyLegOutcome =
  | { status: "live"; url: string; listingId: string }
  | { status: "skipped"; reason: string }
  | { status: "not_connected"; connectUrl: string }
  | { status: "error"; message: string };

export interface PipelineResult {
  itemId: string;
  identification: {
    title: string;
    confidence: number;
    defects: string[];
  };
  price: PriceDecision;
  routing: RoutingDecision;
  publish: PipelinePublishOutcome;
  // Present only when the routing table adds Etsy.
  etsy?: EtsyLegOutcome;
}

export interface PipelineInput {
  userId: string;
  imageBase64: string;
  mimeType: AcceptedMimeType;
  // Seller-entered cost basis at intake (P1-4); null → floor assumes $0.
  costBasis: number | null;
  // Optional seller target price; null → floor-markup strategy.
  targetPrice: number | null;
}

// ─── Injectable dependencies ──────────────────────────────────────────────────

export interface PipelineDeps {
  identify(image: string, mime: AcceptedMimeType): Promise<IdentifiedItem>;
  hostPhoto(bytes: Uint8Array, mime: AcceptedMimeType): Promise<string>;
  createDraft(
    userId: string,
    input: DraftItemInput,
    photoUrl: string | null
  ): Promise<string>;
  price(req: PriceRequest): PriceDecision;
  // Market comps — best-effort; null means "price conservatively".
  fetchComps(userId: string, query: string): Promise<CompsSummary | null>;
  recordPrice(
    userId: string,
    itemId: string,
    decision: PriceDecision
  ): Promise<void>;
  setPrice(userId: string, itemId: string, price: number): Promise<void>;
  setReview(
    userId: string,
    itemId: string,
    reasons: Array<{ gate: string; reason: string }>
  ): Promise<void>;
  guardrails(input: Parameters<typeof evaluateGuardrails>[0]): GuardrailVerdict;
  audit: typeof recordAudit;
  getEbayConnection(userId: string): Promise<PlatformConnection | null>;
  publishEbay(
    conn: PlatformConnection,
    listing: ListingInput,
    imageUrls: string[],
    // Deterministic item-derived SKU — retries reuse the same eBay
    // inventory item/offer instead of duplicating the listing.
    sku: string
  ): Promise<EbayPublishResult>;
  getEtsyConnection(userId: string): Promise<PlatformConnection | null>;
  publishEtsy(
    conn: PlatformConnection,
    listing: ListingInput,
    imageBytes: Uint8Array,
    mimeType: AcceptedMimeType
  ): Promise<EtsyPublishResult>;
  route(extraction: Parameters<typeof routeChannels>[0]): RoutingDecision;
  getItem(userId: string, itemId: string): Promise<ItemDetailRow | null>;
  approveReview(userId: string, itemId: string): Promise<boolean>;
  recordListing(
    userId: string,
    itemId: string,
    listing: LiveListing,
    price: number
  ): Promise<void>;
  markListed(itemId: string): Promise<void>;
  recordAttempt(
    userId: string,
    itemId: string | null,
    platform: string,
    status: "live" | "assist" | "not_connected" | "error",
    error?: string
  ): Promise<void>;
  // Persist-before-publish: 'pending' row BEFORE the marketplace call;
  // beginAttempt THROWS when it can't persist (then nothing is published).
  beginAttempt(
    userId: string,
    itemId: string | null,
    platform: string
  ): Promise<string>;
  completeAttempt(
    attemptId: string,
    completion: PublishAttemptCompletion
  ): Promise<boolean>;
  publishMode(): PublishMode;
}

const defaultDeps: PipelineDeps = {
  identify: identifyItem,
  hostPhoto: hostListingPhoto,
  createDraft: createDraftItem,
  price: decidePrice,
  async fetchComps(userId, query) {
    try {
      const conn = await getConnection(userId, "ebay");
      if (!conn) return null;
      return await fetchEbayComps(conn.accessToken, query);
    } catch {
      return null;
    }
  },
  recordPrice: recordPriceDecision,
  setPrice: setItemPrice,
  setReview: setItemReview,
  guardrails: evaluateGuardrails,
  audit: recordAudit,
  getEbayConnection: (userId) => getConnection(userId, "ebay"),
  publishEbay: publishToEbay,
  getEtsyConnection: (userId) => getConnection(userId, "etsy"),
  publishEtsy: publishToEtsy,
  route: routeChannels,
  getItem: getItemDetail,
  approveReview: approveItemFromReview,
  recordListing: recordLiveListing,
  markListed: markItemListed,
  recordAttempt: recordPublishAttempt,
  beginAttempt: beginPublishAttempt,
  completeAttempt: completePublishAttempt,
  publishMode: resolvePublishMode,
};

// ─── Orchestration ────────────────────────────────────────────────────────────

export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps = defaultDeps
): Promise<PipelineResult> {
  // 1. Identify. A VisionError here aborts the pipeline — the route maps it.
  const identified = await deps.identify(input.imageBase64, input.mimeType);
  const extraction = identified.extraction;

  // 2. Host the photo (eBay requires a public URL). Photo hosting failure
  //    shouldn't lose the identification — the draft persists without it and
  //    the publish step reports the problem.
  const bytes = new Uint8Array(Buffer.from(input.imageBase64, "base64"));
  let photoUrl: string | null = null;
  let photoError: string | null = null;
  try {
    photoUrl = await deps.hostPhoto(bytes, input.mimeType);
  } catch (err) {
    photoError = err instanceof Error ? err.message : "photo hosting failed";
  }

  // 3. Persist the draft the moment identification succeeds.
  const itemId = await deps.createDraft(
    input.userId,
    {
      title: extraction.title,
      brand: extraction.brand,
      model: extraction.model,
      upc: extraction.upc,
      condition: extraction.condition,
      category: extraction.category,
      specs: extraction.specs,
      defects: identified.defects,
      idConfidence: identified.confidence,
      costOfGoods: input.costBasis,
      shippingCost: extraction.estimatedShippingCost,
    },
    photoUrl
  );

  // 4. Price it; the decision and its rationale go to price_history.
  //    Comps are best-effort — a failed lookup means conservative pricing.
  const comps = await deps.fetchComps(input.userId, extraction.title);
  const decision = deps.price({
    costBasis: input.costBasis,
    shippingCost: extraction.estimatedShippingCost,
    targetPrice: input.targetPrice,
    comps,
    // Comps-grounded pricing (docs/design/comps-pricing.md): the AI price is
    // only the seed when comps are sparse — such items go to review.
    aiSuggestedPrice: extraction.suggestedPrice,
    condition: extraction.condition,
    defectCount: identified.defects.length,
    completeInBox: Object.entries(extraction.specs).some(([k, v]) =>
      /complete|in box|with box/i.test(`${k} ${v}`)
    ),
  });
  await deps.recordPrice(input.userId, itemId, decision);
  await deps.setPrice(input.userId, itemId, decision.price);

  const listing: ListingInput = {
    title: extraction.title,
    brand: extraction.brand,
    model: extraction.model,
    upc: extraction.upc,
    condition: extraction.condition,
    category: extraction.category,
    specs: extraction.specs,
    price: decision.price,
    shippingCost: extraction.estimatedShippingCost,
  };

  // 5. Guardrails — the auto-post decision. ALL gates must pass; any failure
  //    parks the item in the review queue instead of publishing (P0-5).
  const verdict = deps.guardrails({
    confidence: identified.confidence,
    price: decision.price,
    floor: decision.floor,
    // Ungrounded price (no trusted comps, no seller target) → review.
    priceGrounded: decision.grounded,
    // null (MANUAL_ESTIMATE_NEEDED) fails the shipping_unknown gate → review.
    shippingCost: extraction.estimatedShippingCost,
    title: extraction.title,
    brand: extraction.brand,
    category: extraction.category,
    specs: extraction.specs,
    defects: identified.defects,
    photoBytes: photoUrl === null ? null : bytes,
  });

  // The routing table decides WHERE this item may be auto-posted (P1-1):
  // eBay always; Etsy only for handmade / vintage 20+yr / craft supply.
  const routing = deps.route(extraction);

  let publish: PipelinePublishOutcome;
  let etsy: EtsyLegOutcome | undefined;
  if (!verdict.autoPost) {
    const failures = verdict.failures.map(({ gate, reason }) => ({ gate, reason }));
    await deps.setReview(input.userId, itemId, failures);
    await deps.audit(input.userId, itemId, "review_hold", null, { failures });
    publish = { mode: deps.publishMode(), status: "review", failures };
  } else {
    // 6. Publish — sandbox for real, dry-run when production isn't opted in.
    publish = await publishStep(input.userId, itemId, listing, photoUrl, photoError, deps);
    if (routing.etsyEligible) {
      etsy = await etsyLeg(input, itemId, listing, bytes, deps);
    }
  }

  return {
    itemId,
    identification: {
      title: extraction.title,
      confidence: identified.confidence,
      defects: identified.defects,
    },
    price: decision,
    routing,
    publish,
    ...(etsy ? { etsy } : {}),
  };
}

// ─── Review-queue approval (P1-2) ─────────────────────────────────────────────

const CONDITIONS: ReadonlyArray<ListingInput["condition"]> = [
  "New",
  "Like New",
  "Very Good",
  "Good",
  "Acceptable",
];

export type ApproveResult =
  | { ok: true; publish: PipelinePublishOutcome }
  | { ok: false; error: string };

/**
 * A human approved a guardrail-held item: release it from review and publish
 * through the same (sandbox/dry-run-safe) publish step. Guardrails are NOT
 * re-run — approval IS the human override. An optional price override is
 * recorded in price_history like any other decision.
 */
export async function approveAndPublish(
  userId: string,
  itemId: string,
  overridePrice: number | null = null,
  deps: PipelineDeps = defaultDeps
): Promise<ApproveResult> {
  const item = await deps.getItem(userId, itemId);
  if (!item) return { ok: false, error: "Item not found" };
  if (item.status !== "review") {
    return { ok: false, error: "Item is not awaiting review" };
  }

  const price = overridePrice ?? item.price;
  if (price === null || price <= 0) {
    return { ok: false, error: "Set a price before approving" };
  }
  if (overridePrice !== null) {
    await deps.setPrice(userId, itemId, overridePrice);
    await deps.recordPrice(userId, itemId, {
      price: overridePrice,
      floor: overridePrice,
      strategy: "user_target",
      grounded: true, // the seller chose it
      rationale: "Review-queue approval with a manual price override.",
      inputs: { targetPrice: overridePrice },
    });
  }

  const released = await deps.approveReview(userId, itemId);
  if (!released) return { ok: false, error: "Item is not awaiting review" };
  await deps.audit(userId, itemId, "review_approve", null, { price });

  const publish = await publishStep(
    userId,
    itemId,
    listingFromItem(item, price),
    item.photo_url,
    item.photo_url === null ? "no stored photo for this item" : null,
    deps,
    true // human approval — never a silent dry run
  );
  return { ok: true, publish };
}

// ─── Draft publish / retry ────────────────────────────────────────────────────

export type DraftPublishResult =
  | { ok: true; publish: PipelinePublishOutcome }
  | { ok: false; error: string };

/**
 * Publish (or retry) a stored draft — the action every orphaned draft was
 * missing: items whose one-shot publish failed, or that were delisted back
 * to draft. Rebuilds the listing entirely from the stored row; NEVER re-runs
 * AI identification and NEVER spends a credit — the credit already paid for
 * the extraction that created this draft. Retrying a failed publish is the
 * same call: publish_attempts records each try, and the item only leaves
 * draft when a publish actually goes live.
 */
export async function publishDraft(
  userId: string,
  itemId: string,
  deps: PipelineDeps = defaultDeps
): Promise<DraftPublishResult> {
  const item = await deps.getItem(userId, itemId);
  if (!item) return { ok: false, error: "Item not found" };
  if (item.status !== "draft") {
    return {
      ok: false,
      error:
        item.status === "review"
          ? "This item is held for review — approve or reject it in the review queue."
          : "Only drafts can be published.",
    };
  }
  if (item.price === null || item.price <= 0) {
    return { ok: false, error: "Set a price before publishing." };
  }
  // The money rule at the door: unknown shipping never publishes as $0.
  if (item.shipping_cost === null) {
    return {
      ok: false,
      error:
        "We couldn't estimate shipping for this item — enter a shipping cost before publishing.",
    };
  }

  await deps.audit(userId, itemId, "draft_publish", null, { price: item.price });
  const publish = await publishStep(
    userId,
    itemId,
    listingFromItem(item, item.price),
    item.photo_url,
    item.photo_url === null ? "no stored photo for this item" : null,
    deps,
    true // seller clicked Publish — same standing as /api/publish
  );
  return { ok: true, publish };
}

// Rebuild the publishable listing from what the draft already stored — the
// republish path must never need a fresh AI extraction (or a credit).
function listingFromItem(item: ItemDetailRow, price: number): ListingInput {
  return {
    title: item.title,
    brand: item.brand,
    model: item.model,
    upc: item.upc,
    condition: CONDITIONS.includes(item.condition as ListingInput["condition"])
      ? (item.condition as ListingInput["condition"])
      : "Good",
    category: item.category ?? "",
    specs: item.specs ?? {},
    price,
    // The stored estimate — null only when extraction said
    // MANUAL_ESTIMATE_NEEDED and the seller hasn't entered one yet.
    shippingCost: item.shipping_cost,
  };
}

// The optional Etsy leg. Etsy has no sandbox environment, so a real Etsy
// publish only happens in live mode — never during sandbox/dry-run pipeline
// exercise (same safety stance as the eBay production gate).
async function etsyLeg(
  input: PipelineInput,
  itemId: string,
  listing: ListingInput,
  imageBytes: Uint8Array,
  deps: PipelineDeps
): Promise<EtsyLegOutcome> {
  const mode = deps.publishMode();
  if (mode !== "live") {
    return {
      status: "skipped",
      reason: `Etsy-eligible, but Etsy has no sandbox — publishes only in live mode (current: ${mode}).`,
    };
  }
  const conn = await deps.getEtsyConnection(input.userId);
  if (!conn) {
    return { status: "not_connected", connectUrl: "/api/oauth/etsy/start" };
  }
  try {
    const published = await deps.publishEtsy(conn, listing, imageBytes, input.mimeType);
    await deps.recordListing(
      input.userId,
      itemId,
      {
        platform: "etsy",
        url: published.url,
        externalId: published.listingId,
        meta: { shopId: published.shopId },
      },
      listing.price
    );
    await deps.recordAttempt(input.userId, itemId, "etsy", "live");
    await deps.audit(input.userId, itemId, "auto_publish", "etsy", {
      listingId: published.listingId,
      mode,
    });
    return { status: "live", url: published.url, listingId: published.listingId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Etsy publish failed";
    await deps.recordAttempt(input.userId, itemId, "etsy", "error", message);
    return { status: "error", message };
  }
}

async function publishStep(
  userId: string,
  itemId: string,
  listing: ListingInput,
  photoUrl: string | null,
  photoError: string | null,
  deps: PipelineDeps,
  // PIPELINE_LIVE_PUBLISH exists so the AUTOMATED pipeline can't list on
  // production eBay by accident. A human clicking "Publish" / "Approve &
  // post" is explicit intent — same standing as /api/publish, which has
  // never been gated by the flag — so user-initiated publishes upgrade
  // dry_run to live. Sandbox stays sandbox either way.
  userInitiated = false
): Promise<PipelinePublishOutcome> {
  let mode = deps.publishMode();
  if (userInitiated && mode === "dry_run") mode = "live";

  if (mode === "dry_run") {
    // Build the exact payload eBay would receive; touch nothing.
    return {
      mode: "dry_run",
      status: "dry_run",
      payload: buildEbayInventoryItemPayload(listing, [
        photoUrl ?? "https://dry-run.invalid/photo.jpg",
      ]),
    };
  }

  if (photoUrl === null) {
    const message = `Photo hosting failed — cannot publish: ${photoError ?? "unknown error"}`;
    await deps.recordAttempt(userId, itemId, "ebay", "error", message);
    return { mode, status: "error", message };
  }

  const conn = await deps.getEbayConnection(userId);
  if (!conn) {
    await deps.recordAttempt(userId, itemId, "ebay", "not_connected");
    return {
      mode,
      status: "not_connected",
      connectUrl: "/api/oauth/ebay/start",
    };
  }

  // Persist-before-publish: the attempt row must exist BEFORE eBay is
  // called. If it can't be written, nothing is published — an untracked
  // live listing is the exact failure this prevents.
  let attemptId: string;
  try {
    attemptId = await deps.beginAttempt(userId, itemId, "ebay");
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      mode,
      status: "error",
      message: `We couldn't record this publish attempt, so nothing was sent to eBay — try again. (${detail})`,
    };
  }

  let published: EbayPublishResult;
  try {
    published = await deps.publishEbay(conn, listing, [photoUrl], ebaySkuForItem(itemId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "publish failed";
    await deps.completeAttempt(attemptId, { status: "error", error: message });
    return { mode, status: "error", message, attemptId };
  }

  // The listing is LIVE on eBay from here on. Any local recording failure
  // must leave a reconciliation_required row carrying the platform ids —
  // never an unmanaged listing.
  const platformIds = {
    externalId: published.listingId,
    url: published.url,
    meta: { offerId: published.offerId, sku: published.sku },
  };
  try {
    await deps.recordListing(
      userId,
      itemId,
      {
        platform: "ebay",
        url: published.url,
        externalId: published.listingId,
        meta: { offerId: published.offerId, sku: published.sku },
      },
      listing.price
    );
    await deps.markListed(itemId);
    await deps.completeAttempt(attemptId, { status: "live", ...platformIds });
    // P0-8: every automated publish leaves an audit row.
    await deps.audit(userId, itemId, "auto_publish", "ebay", {
      listingId: published.listingId,
      mode,
    });
    return {
      mode,
      status: "live",
      url: published.url,
      listingId: published.listingId,
      attemptId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "recording failed";
    console.error(
      `[pipeline] RECONCILIATION: eBay listing ${published.listingId} is live but local recording failed:`,
      message
    );
    await deps.completeAttempt(attemptId, {
      status: "reconciliation_required",
      error: message,
      ...platformIds,
    });
    return {
      mode,
      status: "live",
      url: published.url,
      listingId: published.listingId,
      attemptId,
      reconciliationRequired: true,
    };
  }
}
