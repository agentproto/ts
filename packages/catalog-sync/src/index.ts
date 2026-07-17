/**
 * @agentproto/catalog-sync
 *
 * Build-time generator framework for @agentproto/model-catalog. Catalog data
 * (prices, model lists) is GENERATED from pinned provider sources, not
 * hand-committed. Each generator reads a committed snapshot
 * (`snapshots/<id>.json`) and emits a `*.generated.ts` drop-in for the
 * catalog package.
 */

export type {
  CatalogSource,
  CatalogGenerator,
  GeneratedFiles,
  GeneratorContext,
} from "./types.js"
export { defineGenerator } from "./types.js"
export { runGenerators } from "./runner.js"
export type { RunGeneratorsOptions, RunGeneratorsResult } from "./runner.js"
export { llmOpenRouterGenerator } from "./generators/llm-openrouter.js"
export { llmRequestyGenerator } from "./generators/llm-requesty.js"
export { voiceElevenlabs } from "./generators/voice-elevenlabs.js"
export { voiceMinimax } from "./generators/voice-minimax.js"
export { imageReplicate } from "./generators/image-replicate.js"
export {
  reviewedRefresh,
  refreshSources,
} from "./refresh-workflow.js"
export type {
  RefreshableSource,
  SourceRefreshResult,
  CatalogFileDiff,
  ReviewedRefreshOptions,
  ReviewedRefreshResult,
} from "./refresh-workflow.js"
export { OPENAI_LLM_SOURCE, OPENAI_SOURCES } from "./sources/openai.js"
