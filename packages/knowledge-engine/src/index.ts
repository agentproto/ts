/**
 * @agentproto/knowledge-engine — the pure knowledge (retrieval) contract +
 * the `kb_query` / `kb_ingest` tools.
 *
 * This package is backend-agnostic: it defines `IKnowledgeProvider` (the
 * ingest/query contract, lifted verbatim from the already-vendor-neutral
 * studio integration package), the AIP-14 `kb_query` + `kb_ingest` tools,
 * their AIP-30 builtin provider, and thin AIP-29/31/32 surface projections.
 * It takes NO dependency on any concrete retrieval engine (vector store,
 * graph db, BM25) — a backend implements `IKnowledgeProvider` in a separate
 * adapter and is injected via the tool context. That separation is what lets
 * the tools be authored and tested against a fake provider before any real
 * backend exists. The retrieval sibling of `@agentproto/code-brain`.
 */

// Data contract + zod mirrors.
export {
  type KnowledgeCapabilities,
  type KnowledgeSourceKind,
  type KnowledgeSourceStatus,
  type KnowledgeSource,
  type KnowledgeIngestInput,
  type KnowledgeQueryMode,
  type KnowledgeQuery,
  type KnowledgeHit,
  type KnowledgeQueryResult,
  type ListSourcesFilter,
  type CorpusFilter,
  knowledgeSourceKindSchema,
  knowledgeSourceStatusSchema,
  knowledgeQueryModeSchema,
  knowledgeMetadataSchema,
  knowledgeSourceSchema,
  knowledgeHitSchema,
  knowledgeQueryResultSchema,
} from "./types.js"

// Provider contract + tool context schema.
export {
  type IKnowledgeProvider,
  type KnowledgeToolContext,
  knowledgeProviderSchema,
  knowledgeToolContextSchema,
} from "./provider.js"

// Tools.
export {
  kbQueryTool,
  kbQueryInputSchema,
  kbQueryOutputSchema,
  type KbQueryInput,
  type KbQueryOutput,
  kbIngestTool,
  kbIngestInputSchema,
  kbIngestOutputSchema,
  type KbIngestInput,
  type KbIngestOutput,
} from "./tools/index.js"

// Builtin provider + bodies.
export {
  knowledgeEngineProvider,
  kbQueryBuiltin,
  kbIngestBuiltin,
} from "./provider/index.js"
