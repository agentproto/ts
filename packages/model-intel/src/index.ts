/**
 * @agentproto/model-intel — model intelligence primitives.
 *
 * Catalog watch domain: a pure diff of two priced catalog snapshots.
 *
 * The AIP-67 quota API now lives in `@agentproto/quota`. Every quota export is
 * re-exported below for compatibility and is deprecated here.
 */

/** @deprecated Import from @agentproto/quota. */
export {
  SPEC_NAME,
  SPEC_VERSION,
  QUOTA_BASES,
  quotaCreditsSchema,
  quotaStatusSchema,
  quotaWindowSchema,
  buildQuotaStatus,
  remainingPctFromCounts,
  remainingPctFromUsed,
  QuotaReaderRegistry,
  defineQuotaReader,
  quotaFromAnthropicHeaders,
  quotaFromCodexRateLimits,
  createMoonshotQuotaReader,
  createOpenRouterQuotaReader,
} from "@agentproto/quota"

/** @deprecated Import from @agentproto/quota. */
export type {
  QuotaBasis,
  QuotaCredits,
  QuotaProfile,
  QuotaReadContext,
  QuotaReader,
  QuotaStatus,
  QuotaWindow,
  BuildQuotaStatusInput,
  CodexCredits,
  CodexRateLimits,
  CodexRateLimitsInput,
  CodexRateLimitWindow,
} from "@agentproto/quota"

/**
 * Catalog watch domain: pure diff of two priced catalog snapshots.
 */
export { diffCatalog } from "./catalog-diff.js"
export type {
  CatalogDiff,
  CatalogPriceChange,
  CatalogSnapshot,
  CatalogSnapshotEntry,
} from "./catalog-diff.js"
