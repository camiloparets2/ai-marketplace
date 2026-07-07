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
import { createDraftItem, setItemPrice, setItemReview, recordLiveListing, markItemListed, recordPublishAttempt } from "@/lib/inventory";
import type { DraftItemInput, LiveListing } from "@/lib/inventory";
import { evaluateGuardrails } from "@/lib/guardrails";
import type { GuardrailVerdict } from "@/lib/guardrails";
import { recordAudit } from "@/lib/audit";
import { decidePrice, recordPriceDecision } from "@/lib/pricing";
import type { PriceDecision, PriceRequest } from "@/lib/pricing";
import { fetchEbayComps } from "@/lib/comps";
import type { CompsSummary } from "@/lib/comps";
import { publishToEbay, buildEbayInventoryItemPayload } from "@/lib/platforms/ebay";
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
  | { mode: PublishMode; status: "live"; url: string; listingId: string }
  | { mode: "dry_run"; status: "dry_run"; payload: EbayInventoryItemPayload }
  | { mode: PublishMode; status: "not_connected"; connectUrl: string }
  | { mode: PublishMode; status: "error"; message: string }
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
    imageUrl: string
  ): Promise<EbayPublishResult>;
  getEtsyConnection(userId: string): Promise<PlatformConnection | null>;
  publishEtsy(
    conn: PlatformConnection,
    listing: ListingInput,
    imageBytes: Uint8Array,
    mimeType: AcceptedMimeType
  ): Promise<EtsyPublishResult>;
  route(extraction: Parameters<typeof routeChannels>[0]): RoutingDecision;
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
  recordListing: recordLiveListing,
  markListed: markItemListed,
  recordAttempt: recordPublishAttempt,
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
  deps: PipelineDeps
): Promise<PipelinePublishOutcome> {
  const mode = deps.publishMode();

  if (mode === "dry_run") {
    // Build the exact payload eBay would receive; touch nothing.
    return {
      mode: "dry_run",
      status: "dry_run",
      payload: buildEbayInventoryItemPayload(
        listing,
        photoUrl ?? "https://dry-run.invalid/photo.jpg"
      ),
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

  try {
    const published = await deps.publishEbay(conn, listing, photoUrl);
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
    await deps.recordAttempt(userId, itemId, "ebay", "live");
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "publish failed";
    await deps.recordAttempt(userId, itemId, "ebay", "error", message);
    return { mode, status: "error", message };
  }
}
