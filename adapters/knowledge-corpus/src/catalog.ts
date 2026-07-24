import type { AdapterCatalog } from "@agentproto/provider-kit"

/**
 * Family key used for the knowledge backend creds/ledger store path.
 *
 * The corpus engine is the retrieval-composition sibling of the `files`
 * backend — same `knowledge` family, so both surface through the same
 * provider-kit discovery convention (`@agentproto/adapter-knowledge-*`).
 */
export const KNOWLEDGE_FAMILY = "knowledge" as const

/** The single backend slug this adapter provides. */
export const CORPUS_SLUG = "corpus" as const

/**
 * Static catalog of knowledge backends shipped by this adapter. The `corpus`
 * slug resolves from THIS package (`@agentproto/adapter-knowledge-corpus`) —
 * an AIP-10 corpus-composition engine that wraps any backing engine and
 * hydrates every hit with canonical provenance + access policy.
 */
export const KNOWLEDGE_CORPUS_CATALOG: AdapterCatalog = [
  {
    slug: CORPUS_SLUG,
    name: "corpus (AIP-10)",
    description:
      "Composable AIP-10 corpus engine — wraps any backing knowledge " +
      "engine (the files adapter, or an external vector store) and " +
      "hydrates every hit with " +
      "canonical provenance (entryPath, sources, temporal score) + " +
      "access policy. Public ingest/delete are rejected; writes go " +
      "through the privileged corpus lifecycle.",
    packageName: "@agentproto/adapter-knowledge-corpus",
    hint: "corpus · aip-10",
  },
]
