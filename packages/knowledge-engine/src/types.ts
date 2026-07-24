/**
 * @agentproto/knowledge-engine — the pure, backend-agnostic knowledge
 * (retrieval) data contract.
 *
 * These shapes are lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/types/knowledge.types.ts:1-139`) —
 * they were already vendor-neutral with ZERO imports, so the re-home is a
 * lift + rename, not a redesign. They are deliberately *idiom-free*: no
 * concrete engine's query dialect (vector store, graph db, BM25 flags)
 * leaks into these types. A backend adapter translates this contract onto
 * its own vocabulary — its query verbs, source-scope wildcards, and client
 * calls live in that adapter, never here. Keeping the contract clean is what
 * lets `kb_query` / `kb_ingest` be authored, typed, and tested against a
 * fake provider before any real backend exists.
 *
 * The doc-comment mentions of concrete engines below are provenance notes
 * carried over verbatim from the source; the code, types, and deps name no
 * engine.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Lifted verbatim from knowledge.types.ts (studio) — zero runtime imports.
// ---------------------------------------------------------------------------

/**
 * What the engine can actually do — agents and the binding layer
 * check capabilities before routing a query through an adapter.
 */
export interface KnowledgeCapabilities {
  /** Similarity search over embeddings */
  readonly vectorSearch: boolean
  /** Graph traversal over entities/relations */
  readonly graphTraversal: boolean
  /** BM25 + vector fused ranking */
  readonly hybridSearch: boolean
  /** Images / audio / video alongside text */
  readonly multiModal: boolean
  /** Streamed query results */
  readonly streaming: boolean
  /** Returns source spans, not just text */
  readonly citations: boolean
  /** Max bytes per chunk the engine accepts on ingest */
  readonly maxChunkBytes: number
}

export type KnowledgeSourceKind = "file" | "url" | "text" | "connector"

export type KnowledgeSourceStatus = "pending" | "indexing" | "ready" | "failed"

/**
 * The unit users add to a KB (a file, a URL, a page, a pasted text).
 * `TMeta` lets concrete adapters narrow the metadata blob to their own shape.
 */
export interface KnowledgeSource<TMeta = Record<string, unknown>> {
  readonly id: string
  readonly kind: KnowledgeSourceKind
  readonly uri: string
  readonly title?: string
  readonly metadata: Readonly<TMeta>
  readonly bytes: number
  readonly status: KnowledgeSourceStatus
  readonly indexedAt?: Date
  readonly error?: string
}

export interface KnowledgeIngestInput<TMeta = Record<string, unknown>> {
  readonly kind: KnowledgeSourceKind
  readonly uri: string
  readonly title?: string
  /** Optional inline payload — adapters that index by URI may ignore this. */
  readonly content?: Uint8Array | string
  readonly mimeType?: string
  readonly metadata?: TMeta
}

/**
 * `mode` is a hint, not a contract. Adapters that don't support a
 * requested mode fall back to their best available (e.g. graph → vector)
 * and echo the actual mode used in `KnowledgeQueryResult.modeUsed`.
 *
 * `"none"` is the cold-start sentinel: no retrieval ran this turn (e.g. the
 * corpus snapshot was still warming and the query was skipped to protect TTFT),
 * so `hits` is empty and the caller should treat it as "no recall this turn".
 */
export type KnowledgeQueryMode = "vector" | "graph" | "hybrid" | "none"

export interface KnowledgeQuery {
  readonly query: string
  readonly topK?: number
  /** Engine-specific predicate (e.g. metadata filters). */
  readonly filter?: Readonly<Record<string, unknown>>
  readonly mode?: KnowledgeQueryMode
  readonly minScore?: number
}

export interface KnowledgeHit<TMeta = Record<string, unknown>> {
  readonly sourceId: string
  readonly chunkId: string
  readonly text: string
  readonly score: number
  /** Byte range within the source where the hit was found. */
  readonly span?: { readonly start: number; readonly end: number }
  readonly metadata: Readonly<TMeta>
}

export interface KnowledgeQueryResult<TMeta = Record<string, unknown>> {
  readonly hits: readonly KnowledgeHit<TMeta>[]
  readonly tookMs: number
  /** Adapter id that served the query (for logging / tracing). */
  readonly engine: string
  /** The mode actually used (may differ from `KnowledgeQuery.mode`). */
  readonly modeUsed: KnowledgeQueryMode
}

export interface ListSourcesFilter {
  readonly kind?: KnowledgeSourceKind
  readonly status?: KnowledgeSourceStatus
}

/**
 * Convention for the corpus engine + adapters that opt in to corpus
 * provenance round-tripping. Used as the value of `KnowledgeQuery.filter`
 * when the caller wants corpus-aware filtering by AIP-10 provenance
 * fields.
 *
 * The interface is intentionally additive on top of the opaque
 * `Record<string, unknown>` filter shape. Engines that don't recognize
 * any of these keys MUST ignore them rather than throw — callers can
 * mix corpus keys with engine-specific keys freely.
 *
 * Field semantics (all optional):
 *   - status            — entry status to include (default for corpus
 *                          adapters: "active" only)
 *   - kind              — AIP-10 entry kind(s) to include
 *   - domain / channel  — narrow to a workspace facet
 *   - minQualityScore   — `metadata.corpus.qualityScore >= n`
 *   - maxRiskScore      — `metadata.corpus.riskScore <= n`
 *   - mentionedSince    — at least one entry in `metadata.corpus.temporal.mentions[]`
 *                          has `at >= <ISO>`. Bridges through
 *                          `metadata.corpus.temporal.lastSeen` for
 *                          engines that only index the rollup.
 *   - minTemporalScore  — computed at query time from mentions + halfLife;
 *                          enforcement lives in the corpus adapter, not
 *                          the backing engine.
 */
export interface CorpusFilter {
  readonly status?: ReadonlyArray<"active" | "deprecated" | "archived">
  readonly kind?: readonly string[]
  readonly domain?: readonly string[]
  readonly channel?: readonly string[]
  readonly minQualityScore?: number
  readonly maxRiskScore?: number
  readonly mentionedSince?: string
  readonly minTemporalScore?: number
}

// ---------------------------------------------------------------------------
// Zod mirrors — the tool layer added on the agentproto side. These back the
// `kb_query` / `kb_ingest` tool schemas; they are the ONLY runtime addition
// on top of the verbatim-lifted contract above. Mirrors code-brain's
// `types.ts` (`packages/code-brain/src/types.ts`), where the data-type
// mirrors live next to the interfaces they describe.
// ---------------------------------------------------------------------------

/** Zod mirror of {@link KnowledgeSourceKind}. */
export const knowledgeSourceKindSchema = z.enum(["file", "url", "text", "connector"])

/** Zod mirror of {@link KnowledgeSourceStatus}. */
export const knowledgeSourceStatusSchema = z.enum(["pending", "indexing", "ready", "failed"])

/** Zod mirror of {@link KnowledgeQueryMode}. */
export const knowledgeQueryModeSchema = z.enum(["vector", "graph", "hybrid", "none"])

/**
 * Zod mirror of an opaque metadata blob. The contract keeps metadata an
 * unconstrained record (adapters narrow `TMeta`); the tool layer validates
 * only its shape, never its keys.
 */
export const knowledgeMetadataSchema = z.record(z.string(), z.unknown())

/** Zod mirror of {@link KnowledgeSource} (default metadata shape). */
export const knowledgeSourceSchema = z.object({
  id: z.string(),
  kind: knowledgeSourceKindSchema,
  uri: z.string(),
  title: z.string().optional(),
  metadata: knowledgeMetadataSchema,
  bytes: z.number().int().nonnegative(),
  status: knowledgeSourceStatusSchema,
  indexedAt: z.date().optional(),
  error: z.string().optional(),
})

/** Zod mirror of {@link KnowledgeHit} (default metadata shape). */
export const knowledgeHitSchema = z.object({
  sourceId: z.string(),
  chunkId: z.string(),
  text: z.string(),
  score: z.number(),
  span: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
  metadata: knowledgeMetadataSchema,
})

/** Zod mirror of {@link KnowledgeQueryResult} (default metadata shape). */
export const knowledgeQueryResultSchema = z.object({
  hits: z.array(knowledgeHitSchema).readonly(),
  tookMs: z.number().nonnegative(),
  engine: z.string(),
  modeUsed: knowledgeQueryModeSchema,
})
