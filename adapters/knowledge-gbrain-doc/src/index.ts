/**
 * @agentproto/adapter-knowledge-gbrain-doc — the gbrain DOCUMENT backing for the
 * `@agentproto/knowledge-engine` `IKnowledgeProvider` contract.
 *
 * Ships the contract implementation ({@link GbrainDocKnowledgeAdapter}) over a
 * gbrain server's document API — `put_page` (ingest) + `search` (query), reached
 * over its JSON-RPC `/mcp` endpoint via pure `fetch` (no vendor SDK) — a typed
 * env module that binds it to the ambient `GBRAIN_*` environment, and a
 * provider-kit family that registers it under the `@agentproto/adapter-
 * knowledge-*` discovery convention. Every gbrain wire idiom is confined to this
 * package — `@agentproto/knowledge-engine` and everything above it stay
 * backend-agnostic, and gbrain is reached only at runtime over HTTP.
 *
 * DISTINCT from `@agentproto/adapter-code-brain-gbrain` (the CODE-GRAPH gbrain
 * adapter over `ICodeBrainProvider`). Same backend, different contract, no
 * shared package edge. The document-retrieval sibling of
 * `@agentproto/adapter-knowledge-files` (BM25),
 * `@agentproto/adapter-knowledge-corpus` (AIP-10 composition), and
 * `@agentproto/adapter-knowledge-qdrant` (vector).
 */

// adapter (IKnowledgeProvider implementation) + config + the SSE payload helper
export {
  GbrainDocKnowledgeAdapter,
  gbrainDocKnowledgeAdapter,
  GBRAIN_DOC_ENGINE_ID,
  GBRAIN_DOC_CAPABILITIES,
  GbrainDocAdapterConfigSchema,
  parseGbrainDocAdapterConfig,
  extractJsonRpcPayload,
  type GbrainDocAdapterConfig,
} from "./adapter.js"

// standalone backing (typed env → adapter)
export { createStandaloneGbrainDocAdapter } from "./standalone.js"

// typed env
export {
  loadGbrainDocKnowledgeEnv,
  gbrainDocEnvToConfig,
  type GbrainDocKnowledgeEnv,
} from "./env.js"

// provider-kit family
export {
  KNOWLEDGE_FAMILY,
  GBRAIN_DOC_SLUG,
  KNOWLEDGE_GBRAIN_DOC_CATALOG,
} from "./catalog.js"
export {
  resolveKnowledgeBackend,
  makeKnowledgeGbrainDocResolver,
  type KnowledgeGbrainDocInfo,
  type KnowledgeHandle,
} from "./handle.js"
