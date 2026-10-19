/**
 * @agentproto/model-intel — model intelligence primitives.
 *
 * Unified, provider-neutral quota status (AIP-67): one QuotaStatus shape with a
 * mandatory `basis`, a never-throw QuotaReader contract, and a reader registry.
 * Unknown is omitted, never fabricated.
 *
 * @see https://agentproto.sh/docs/aip-67
 */

export const SPEC_NAME = "quota/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export {
  QUOTA_BASES,
  quotaCreditsSchema,
  quotaStatusSchema,
  quotaWindowSchema,
} from "./types.js"
export type {
  QuotaBasis,
  QuotaCredits,
  QuotaProfile,
  QuotaReadContext,
  QuotaReader,
  QuotaStatus,
  QuotaWindow,
} from "./types.js"
export {
  buildQuotaStatus,
  remainingPctFromCounts,
  remainingPctFromUsed,
} from "./build.js"
export type { BuildQuotaStatusInput } from "./build.js"
export { QuotaReaderRegistry, defineQuotaReader } from "./registry.js"
export { quotaFromAnthropicHeaders } from "./readers/anthropic.js"
