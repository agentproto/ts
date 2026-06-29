/**
 * LLM subpath. Exposes the historical `LLM_PRICING_CATALOG` and
 * `calculateLLMCreditCost` API verbatim (for back-compat with
 * the app legacy pricing module consumers) plus the new alias
 * resolver and curated SDK-ready model ids.
 */
export {
  LLM_PRICING_CATALOG,
  MODEL_ALIASES,
  DEFAULT_PRICING,
  resolvePricing,
  resolveAlias,
  getModelProvider,
  resolveModelRoute,
  calculateLLMCreditCost,
  getCacheStats,
} from "./catalog.js"
export type {
  LLMPricing,
  LLMUsageBreakdown,
  LLMCreditCostResult,
  CalculateLLMCreditCostOptions,
  CacheStats,
  LlmModelId,
  LlmModelAlias,
  KnownLlmId,
  ModelRoute,
} from "./catalog.js"
export {
  WORKFLOW_FAST_MODEL,
  WORKFLOW_PREMIUM_MODEL,
  WORKFLOW_TINY_MODEL,
  OPERATOR_AGENT_MODELS,
  OPERATOR_DEFAULT_PREMIUM,
  OPERATOR_DEFAULT_STANDARD,
  OPERATOR_DEFAULT_GEMINI,
  LLM_TIERS,
} from "./defaults.js"
export type { OperatorAgentModel, LlmTierName } from "./defaults.js"
