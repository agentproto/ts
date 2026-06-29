/**
 * @agentproto/model-catalog — unified model catalog.
 *
 * Single source of truth for LLM, image, video, audio, and voice model
 * entries. Owns cost dispatch, BYOK policy, and access control evaluation.
 * Zod-only OSS core; @agentproto/model-catalog layers billing/access/BYOK
 * policy on top.
 *
 * Subpath imports for tree-shaking:
 *   import { LLM_PRICING_CATALOG } from "@agentproto/model-catalog/llm"
 *   import { calculateCost } from "@agentproto/model-catalog/cost"
 *   import { shouldDebit } from "@agentproto/model-catalog/byok"
 *   import { evaluateAccess } from "@agentproto/model-catalog/access"
 *   import { VOICE_CATALOG } from "@agentproto/model-catalog/voice"
 *   import { listSurfaced } from "@agentproto/model-catalog/curation"
 */

export * from "./schema/index.js"
// LLM has its own `resolveAlias` (legacy back-compat for the app legacy pricing module).
// At the top level we prefer the cross-kind `resolveAlias` from the registry.
export {
  LLM_PRICING_CATALOG,
  MODEL_ALIASES,
  DEFAULT_PRICING,
  resolvePricing,
  calculateLLMCreditCost,
} from "./llm/index.js"
export type {
  LLMPricing,
  LLMUsageBreakdown,
  LLMCreditCostResult,
} from "./llm/index.js"
export * from "./image/index.js"
export * from "./video/index.js"
export * from "./audio/index.js"
export * from "./voice/index.js"
export * from "./curation/index.js"
export * from "./pricing/index.js"
export * from "./cost/index.js"
export * from "./byok/index.js"
export * from "./access/index.js"
export * from "./overlay/index.js"
export * from "./registry/index.js"
export {
  getActions,
  isActionTag,
  assertReservedPrefixDiscipline,
} from "./registry/actions.js"
export {
  getEnrichment,
  modelHasTag,
  modelHasAction,
  modelMatchesCatalogPriceTier,
  modelMatchesPriceTier,
  modelMatchesKind,
  priceTierForModel,
  type ModelEnrichment,
} from "./enrichment/index.js"

import { getModel } from "./registry/index.js"
import { priceTierForModel as priceTierForModelInternal } from "./enrichment/index.js"

/**
 * Display price gauge level (1..5) for a model id — resolves the catalog
 * entry then defers to {@link priceTierForModel}. 0 for an unknown id.
 * The id→level convenience used by the WhatsApp / slash pickers, which carry
 * a model id rather than a resolved model.
 */
export function priceTierForModelId(id: string): number {
  const model = getModel(id)
  return model ? priceTierForModelInternal(model) : 0
}
export type {
  AvailableModel,
  AvailableModelCapabilities,
  AvailableConnector,
  AvailableModelsActor,
  AvailableModelsResponse,
  ListAvailableModelsParams,
} from "./picker/index.js"
