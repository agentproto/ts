/**
 * @agentproto/workspace-brain — a per-workspace "brain".
 *
 * Indexes the conversations of a workspace's agent sessions into a queryable
 * knowledge store so agents can recall what a workspace's sessions actually
 * did. The store is a {@link FederatedKnowledgeProvider} over any of the
 * `@agentproto/adapter-knowledge-*` backends — BM25 (files), gbrain doc API,
 * Qdrant — configured per-workspace via `knowledge.json` (see the resolver);
 * the default config is a single `files` provider, exactly the pre-
 * multi-provider behavior. Pure engine: it never reads a real conversation
 * store itself — the host injects the transcript reader through
 * {@link BrainConfig.readSession}. Reuses the `IKnowledgeProvider` contract,
 * corpus's `ConversationImporter`, and the zero-dep files adapter.
 */

// Types
export type {
  BrainConfig,
  BrainStats,
  BrainStateRecord,
  BrainStateSkip,
  ExportedSessionLike,
  IngestReport,
  IngestResult,
  KnowledgeConfig,
  KnowledgeProviderConfig,
  KnowledgeProviderAdapterId,
} from "./types.js"

// Persistence
export {
  createBrainState,
  brainStatePath,
  BRAIN_STATE_FILENAME,
  type BrainState,
} from "./brain-state.js"

// Session → ConversationSourcePort bridge
export {
  BrainSessionSourcePort,
  type BrainSessionSourcePortOptions,
} from "./session-source-port.js"

// Import loop
export { IngestPipeline, type IngestPipelineOptions } from "./ingest-pipeline.js"

// Knowledge provider resolution (config → live adapters)
export {
  KNOWLEDGE_PROVIDER_ADAPTERS,
  resolveSecret,
  resolveKnowledgeProvider,
  resolveKnowledgeProviders,
  knowledgeConfigSchema,
  parseKnowledgeConfig,
  type ProviderResolutionContext,
  type ResolvedProvider,
} from "./provider-resolver.js"

// Federated fan-out provider
export {
  FederatedKnowledgeProvider,
  type FederatedProvidersOptions,
} from "./federated-provider.js"

// Orchestrator
export { createBrainManager, type BrainManager } from "./brain-manager.js"

// Re-export the provider contract so hosts don't need a direct dep on
// @agentproto/knowledge-engine just to hold a brain's provider.
export type {
  IKnowledgeProvider,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeHit,
  KnowledgeSource,
} from "@agentproto/knowledge-engine"
