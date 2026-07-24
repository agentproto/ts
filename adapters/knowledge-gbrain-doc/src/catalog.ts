import type { AdapterCatalog } from "@agentproto/provider-kit"

/**
 * Family key used for the knowledge backend creds/ledger store path.
 *
 * The gbrain-doc engine is the document-retrieval sibling of the `files`
 * (BM25), `corpus` (AIP-10 composition), and `qdrant` (vector) backends — same
 * `knowledge` family, so all four surface through the same provider-kit
 * discovery convention (`@agentproto/adapter-knowledge-*`).
 */
export const KNOWLEDGE_FAMILY = "knowledge" as const

/** The single backend slug this adapter provides. */
export const GBRAIN_DOC_SLUG = "gbrain-doc" as const

/**
 * Static catalog of knowledge backends shipped by this adapter. The `gbrain-doc`
 * slug resolves from THIS package (`@agentproto/adapter-knowledge-gbrain-doc`) —
 * document retrieval over a gbrain server's `put_page` / `search` API, reached
 * over its JSON-RPC `/mcp` endpoint via pure `fetch` (no vendor SDK). Needs a
 * gbrain endpoint + a machine bearer token, so it requires a setup pass.
 *
 * DISTINCT from `@agentproto/adapter-code-brain-gbrain` (the code-graph gbrain
 * adapter) — same backend, different contract, no shared package edge.
 */
export const KNOWLEDGE_GBRAIN_DOC_CATALOG: AdapterCatalog = [
  {
    slug: GBRAIN_DOC_SLUG,
    name: "gbrain (doc)",
    description:
      "Document knowledge retrieval over a gbrain server's put_page / search " +
      "API, reached over its JSON-RPC /mcp endpoint via pure fetch — no vendor " +
      "SDK. gbrain fuses lexical (tsvector) + semantic recall. Needs a gbrain " +
      "endpoint + a machine bearer token. Distinct from the code-graph gbrain " +
      "adapter.",
    packageName: "@agentproto/adapter-knowledge-gbrain-doc",
    hint: "gbrain · doc",
  },
]
