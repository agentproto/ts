/**
 * @agentproto/workspace-brain — a per-workspace "brain".
 *
 * Indexes the conversations of a workspace's agent sessions into a queryable
 * knowledge store (BM25 via `@agentproto/adapter-knowledge-files`) so agents
 * can recall what a workspace's sessions actually did. Pure engine: it never
 * reads a real conversation store itself — the host injects the transcript
 * reader through {@link BrainConfig.readSession}. Reuses the
 * `IKnowledgeProvider` contract, corpus's `ConversationImporter`, and the
 * zero-dep files adapter.
 */

// Types
export type {
  BrainConfig,
  BrainStats,
  BrainStateRecord,
  ExportedSessionLike,
  IngestReport,
  IngestResult,
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
