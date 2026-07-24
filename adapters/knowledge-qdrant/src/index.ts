/**
 * @agentproto/adapter-knowledge-qdrant — the vector-search backing for the
 * `@agentproto/knowledge-engine` `IKnowledgeProvider` contract.
 *
 * Ships the contract implementation ({@link QdrantKnowledgeAdapter}) over a
 * Qdrant collection — reached via pure `fetch` (upsert/search/scroll) with
 * OpenAI-compatible embeddings (`text-embedding-3-small`, 1536d), no vendor
 * SDK — a typed env module that binds it to the ambient `QDRANT_*` / `OPENAI_*`
 * environment, and a provider-kit family that registers it under the
 * `@agentproto/adapter-knowledge-*` discovery convention. Every Qdrant/OpenAI
 * wire idiom is confined to this package — `@agentproto/knowledge-engine` and
 * everything above it stay backend-agnostic.
 *
 * The optional `tenantId` payload scope (renamed from the studio original's
 * `guildId` — no app/guild coupling survives here) isolates many tenants in
 * one shared collection. The vector-search sibling of
 * `@agentproto/adapter-knowledge-files` (BM25) and
 * `@agentproto/adapter-knowledge-corpus` (AIP-10 composition).
 */

// adapter (IKnowledgeProvider implementation) + config + filter translation
export {
  QdrantKnowledgeAdapter,
  QDRANT_ENGINE_ID,
  QDRANT_CAPABILITIES,
  QdrantAdapterConfigSchema,
  parseQdrantAdapterConfig,
  translateFilter,
  type QdrantAdapterConfig,
  type QdrantFilter,
  type QdrantFilterClause,
} from "./adapter.js"

// standalone backing (typed env → adapter)
export { createStandaloneQdrantAdapter } from "./standalone.js"

// typed env
export {
  loadQdrantKnowledgeEnv,
  qdrantEnvToConfig,
  type QdrantKnowledgeEnv,
} from "./env.js"

// provider-kit family
export {
  KNOWLEDGE_FAMILY,
  QDRANT_SLUG,
  KNOWLEDGE_QDRANT_CATALOG,
} from "./catalog.js"
export {
  resolveKnowledgeBackend,
  makeKnowledgeQdrantResolver,
  type KnowledgeQdrantInfo,
  type KnowledgeHandle,
} from "./handle.js"
