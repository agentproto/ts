/**
 * Typed environment module for the qdrant knowledge adapter.
 *
 * Every `process.env` read in this package flows through here — no raw
 * `process.env.X` at a call site (mirrors the code-brain + files + corpus
 * adapters' `env.ts`). The loader parses the ambient env into a typed,
 * validated config once, so the rest of the adapter is a pure function of its
 * inputs. This is the ONE place the qdrant-engine env names (`QDRANT_*` +
 * `OPENAI_*`) live, keeping the backend idiom confined to the adapter.
 *
 * The `guildId` payload-scope of the studio original was renamed to a generic
 * `tenantId` here — the adapter carries NO app/guild coupling, so the env name
 * (`KNOWLEDGE_QDRANT_TENANT_ID`) is app-neutral too.
 */

import type { QdrantAdapterConfig } from "./adapter.js"

/**
 * Config for the standalone qdrant backend — a Qdrant endpoint + collection,
 * OpenAI-compatible embeddings, and an optional tenant scope.
 */
export interface QdrantKnowledgeEnv {
  /** Base URL of the Qdrant instance (`QDRANT_URL`). Required. */
  readonly endpoint: string
  /** Collection to read/write (`QDRANT_COLLECTION`). Default `"knowledge"`. */
  readonly collection: string
  /** Qdrant API key sent as the `api-key` header (`QDRANT_API_KEY`). Optional
   *  — unsecured local deployments need none. */
  readonly apiKey?: string
  /** OpenAI-compatible key used to compute embeddings (`OPENAI_API_KEY`).
   *  Required — without it the adapter can't ingest or query. */
  readonly embeddingApiKey: string
  /** Embedding model id (`OPENAI_EMBEDDING_MODEL`). Default
   *  `"text-embedding-3-small"` (1536 dims). */
  readonly embeddingModel: string
  /** OpenAI-compatible base URL (`OPENAI_BASE_URL`) — route through Azure /
   *  Ollama / vLLM. Default `"https://api.openai.com/v1"`. */
  readonly embeddingEndpoint: string
  /** Optional tenant scope (`KNOWLEDGE_QDRANT_TENANT_ID`). When set, ingest
   *  tags every point with this tenantId and query/get/delete force a `must`
   *  tenantId clause — so ONE shared collection safely isolates many tenants.
   *  Unset = single-tenant mode (the collection itself is the boundary). */
  readonly tenantId?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * Load {@link QdrantKnowledgeEnv} from `process.env` with defaults.
 *
 * Throws when `QDRANT_URL` or `OPENAI_API_KEY` is absent — the adapter cannot
 * reach the store or embed a query without them, and failing at construction
 * time is clearer than a connection error on the first call.
 */
export function loadQdrantKnowledgeEnv(): QdrantKnowledgeEnv {
  const endpoint = nonEmpty(process.env.QDRANT_URL)
  if (endpoint === undefined) {
    throw new Error(
      "QDRANT_URL is required for the qdrant knowledge adapter; set it to the base URL of your Qdrant instance (e.g. http://127.0.0.1:6333).",
    )
  }
  const embeddingApiKey = nonEmpty(process.env.OPENAI_API_KEY)
  if (embeddingApiKey === undefined) {
    throw new Error(
      "OPENAI_API_KEY is required for the qdrant knowledge adapter; it computes embeddings via an OpenAI-compatible /embeddings endpoint.",
    )
  }
  return {
    endpoint,
    collection: nonEmpty(process.env.QDRANT_COLLECTION) ?? "knowledge",
    apiKey: nonEmpty(process.env.QDRANT_API_KEY),
    embeddingApiKey,
    embeddingModel:
      nonEmpty(process.env.OPENAI_EMBEDDING_MODEL) ?? "text-embedding-3-small",
    embeddingEndpoint:
      nonEmpty(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
    tenantId: nonEmpty(process.env.KNOWLEDGE_QDRANT_TENANT_ID),
  }
}

/** Project the typed env into an {@link QdrantAdapterConfig}. */
export function qdrantEnvToConfig(env: QdrantKnowledgeEnv): QdrantAdapterConfig {
  return {
    endpoint: env.endpoint,
    collection: env.collection,
    apiKey: env.apiKey,
    embeddingApiKey: env.embeddingApiKey,
    embeddingModel: env.embeddingModel,
    embeddingEndpoint: env.embeddingEndpoint,
    tenantId: env.tenantId,
  }
}
