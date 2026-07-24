import type { AdapterCatalog } from "@agentproto/provider-kit"

/**
 * Family key used for the knowledge backend creds/ledger store path.
 *
 * The retrieval sibling of the `code-brain` family: the provider-kit
 * discovery convention (`@agentproto/adapter-knowledge-*`) points every
 * knowledge backend at its providing package.
 */
export const KNOWLEDGE_FAMILY = "knowledge" as const

/** The single backend slug this adapter provides. */
export const FILES_BM25_SLUG = "files" as const

/**
 * Static catalog of knowledge backends shipped by this adapter. The `files`
 * slug resolves from THIS package (`@agentproto/adapter-knowledge-files`) —
 * an in-process BM25 index over local workspace files, no embeddings, no
 * network, no credential.
 */
export const KNOWLEDGE_FILES_CATALOG: AdapterCatalog = [
  {
    slug: FILES_BM25_SLUG,
    name: "files (BM25)",
    description:
      "Knowledge retrieval from local workspace files via an in-process " +
      "BM25 index. No embeddings, no network, no API key — works the " +
      "instant a workspace has files to index.",
    packageName: "@agentproto/adapter-knowledge-files",
    hint: "files · bm25",
  },
]
