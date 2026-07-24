import type { AdapterCatalog } from "@agentproto/provider-kit"

/**
 * Family key used for the knowledge backend creds/ledger store path.
 *
 * The qdrant engine is the vector-search sibling of the `files` (BM25) and
 * `corpus` (AIP-10 composition) backends — same `knowledge` family, so all
 * three surface through the same provider-kit discovery convention
 * (`@agentproto/adapter-knowledge-*`).
 */
export const KNOWLEDGE_FAMILY = "knowledge" as const

/** The single backend slug this adapter provides. */
export const QDRANT_SLUG = "qdrant" as const

/**
 * Static catalog of knowledge backends shipped by this adapter. The `qdrant`
 * slug resolves from THIS package (`@agentproto/adapter-knowledge-qdrant`) —
 * dense/vector retrieval over a Qdrant collection with OpenAI-compatible
 * embeddings, reached via pure `fetch` (no vendor SDK). Needs a `QDRANT_URL`
 * and an `OPENAI_API_KEY`, so it requires a setup pass.
 */
export const KNOWLEDGE_QDRANT_CATALOG: AdapterCatalog = [
  {
    slug: QDRANT_SLUG,
    name: "qdrant (vector)",
    description:
      "Dense/vector knowledge retrieval over a Qdrant collection with " +
      "OpenAI-compatible embeddings (text-embedding-3-small, 1536d), via " +
      "pure fetch — no vendor SDK. Optional tenant scope isolates many " +
      "tenants in one shared collection. Needs a Qdrant endpoint + an " +
      "embeddings API key.",
    packageName: "@agentproto/adapter-knowledge-qdrant",
    hint: "qdrant · vector",
  },
]
