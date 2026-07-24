/**
 * QdrantKnowledgeAdapter — the `IKnowledgeProvider` over a Qdrant collection.
 *
 * Connects the `@agentproto/knowledge-engine` `IKnowledgeProvider` contract to
 * a Qdrant collection. Embeddings via an OpenAI-compatible `/embeddings`
 * endpoint (`text-embedding-3-small`, 1536d, by default) — no vendor SDK, just
 * `fetch`. Lets a host plug "my own Qdrant" as a first-class knowledge engine
 * alongside the files / corpus backends.
 *
 * Lifted from the studio integration package
 * (`packages/integration/knowledge/src/providers/qdrant/adapter.ts`). Two
 * changes on the lift:
 *   1. The contract + data types now come from `@agentproto/knowledge-engine`
 *      (was the studio `../base-knowledge.provider` / `../../types`).
 *   2. The `guildId` tenant-scope field — a forced payload filter with NO
 *      behavioural guild coupling — was renamed to a generic **`tenantId`**.
 *      Nothing here imports any studio package or knows what a guild is; the
 *      field is a plain multi-tenant partition key on the point payload.
 * The studio `qdrant/runtime.ts` (the workstation-substrate lifecycle) is NOT
 * lifted — it belonged to the guild runtime substrate; this package registers
 * as a provider-kit family instead (see `handle.ts`).
 *
 * Scope of this adapter:
 *   - `ingest({ kind: "text", content })` — chunk + embed + upsert
 *   - `ingest({ kind: "url", uri })` — fetch URL body, then as above
 *   - `query({ query, topK, mode: "vector" })` — embed query + search
 *   - `listSources()` — scroll points grouped by source id (client-side dedupe)
 *   - `getSource(id)` / `deleteSource(id)` — by `source_id` payload filter
 *   - `healthCheck()` — `GET /collections/{name}` returns OK
 *
 * Out of scope (throws — surfaced as a clean error):
 *   - `kind: "file"` / `kind: "connector"` ingestion (needs a host-side
 *     resolver; the adapter stays narrow)
 *   - `graph` / `hybrid` query modes (Qdrant is vector-only here; falls back to
 *     vector and stamps `modeUsed: "vector"`)
 */

import { z } from "zod"
import {
  knowledgeMetadataSchema,
  knowledgeSourceKindSchema,
  type IKnowledgeProvider,
  type KnowledgeCapabilities,
  type KnowledgeHit,
  type KnowledgeIngestInput,
  type KnowledgeQuery,
  type KnowledgeQueryResult,
  type KnowledgeSource,
  type KnowledgeSourceKind,
  type ListSourcesFilter,
} from "@agentproto/knowledge-engine"

export const QDRANT_ENGINE_ID = "qdrant" as const

// ── Config ──────────────────────────────────────────────────────────

export const QdrantAdapterConfigSchema = z.object({
  /** Base URL of the Qdrant instance (no trailing slash needed). */
  endpoint: z.string().url(),
  /** Collection to read/write. Must exist with the right vector size before
   *  ingestion (we don't auto-create — that's an ops decision). */
  collection: z.string().min(1),
  /** Qdrant API key (sent as `api-key` header). Optional for unsecured local
   *  deployments. */
  apiKey: z.string().optional(),
  /** OpenAI-compatible key used to compute embeddings. Required — without it
   *  the adapter can't ingest or query. */
  embeddingApiKey: z.string().min(1),
  /** Embedding model id. Defaults to text-embedding-3-small (1536 dims). */
  embeddingModel: z.string().default("text-embedding-3-small"),
  /** Override the embeddings base URL — route through Azure /
   *  OpenAI-compatible proxies (Ollama, vLLM, …). */
  embeddingEndpoint: z.string().url().default("https://api.openai.com/v1"),
  /** Optional human label for logs. */
  label: z.string().optional(),
  /** Tenant scope. When set (multi-tenant mode), ingest tags every point's
   *  payload with this `tenantId` and query/get/delete force a `must` tenantId
   *  clause — so ONE shared collection safely isolates many tenants. Unset =
   *  single-tenant mode (the collection itself is the boundary). A plain
   *  partition key: the adapter carries NO app/guild coupling. */
  tenantId: z.string().optional(),
})

export type QdrantAdapterConfig = z.infer<typeof QdrantAdapterConfigSchema>

export function parseQdrantAdapterConfig(
  raw: Readonly<Record<string, unknown>>,
): QdrantAdapterConfig {
  return QdrantAdapterConfigSchema.parse(raw)
}

// ── Capabilities ────────────────────────────────────────────────────

export const QDRANT_CAPABILITIES: KnowledgeCapabilities = Object.freeze({
  vectorSearch: true,
  graphTraversal: false,
  hybridSearch: false,
  multiModal: false,
  streaming: false,
  citations: true,
  // Vector-search chunk cap. Larger chunks lose retrieval precision; 2KB keeps
  // each chunk inside a typical embedding window and gives ~1 page per hit.
  maxChunkBytes: 2 * 1024,
})

// ── Chunking ─────────────────────────────────────────────────────────

const CHUNK_TARGET_CHARS = 1500 // ~375 tokens on English prose
const CHUNK_OVERLAP_CHARS = 150

/** Fixed-window splitter with a small overlap. Naive but predictable — the
 *  goal is a dep-free adapter; a smarter sentence/semantic chunker can land
 *  later behind the same call. */
function splitIntoChunks(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= CHUNK_TARGET_CHARS) return [trimmed]
  const chunks: string[] = []
  let cursor = 0
  while (cursor < trimmed.length) {
    const end = Math.min(cursor + CHUNK_TARGET_CHARS, trimmed.length)
    chunks.push(trimmed.slice(cursor, end))
    if (end === trimmed.length) break
    cursor = end - CHUNK_OVERLAP_CHARS
  }
  return chunks
}

// ── Wire shapes (zod-parsed — nothing untyped reaches a call site) ───

/**
 * The point payload written on ingest and read back on query / scroll.
 *
 * `tenantId` (was studio `guildId`) is the multi-tenant partition key — set in
 * multi-tenant mode so one shared collection isolates many tenants via a forced
 * query filter; absent in single-tenant mode. `metadata` round-trips
 * caller-supplied provenance (e.g. AIP-10 corpus fields) verbatim so any hit
 * can surface it without re-reading the canonical source.
 */
const qdrantPayloadSchema = z.object({
  source_id: z.string(),
  chunk_index: z.number(),
  tenantId: z.string().optional(),
  kind: knowledgeSourceKindSchema,
  uri: z.string(),
  title: z.string().optional(),
  text: z.string(),
  bytes: z.number(),
  indexed_at: z.string(),
  metadata: knowledgeMetadataSchema.optional(),
})

type QdrantPointPayload = z.infer<typeof qdrantPayloadSchema>

const qdrantPointIdSchema = z.union([z.string(), z.number()])

const qdrantSearchResponseSchema = z.object({
  result: z.array(
    z.object({
      id: qdrantPointIdSchema,
      score: z.number(),
      payload: qdrantPayloadSchema,
    }),
  ),
})

const qdrantScrollResponseSchema = z.object({
  result: z.object({
    points: z.array(
      z.object({ id: qdrantPointIdSchema, payload: qdrantPayloadSchema }),
    ),
    next_page_offset: z.union([z.string(), z.number(), z.null()]).optional(),
  }),
})

const embeddingsResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).optional(),
})

/** Default list-sources cap. `ListSourcesFilter` carries no `limit` today;
 *  expose the ceiling as a constant so callers know what to expect and there's
 *  a single place to revise it. */
const DEFAULT_LIST_LIMIT = 50
const SCROLL_DEDUPE_CAP = DEFAULT_LIST_LIMIT * 10

// ── Adapter ──────────────────────────────────────────────────────────

export class QdrantKnowledgeAdapter implements IKnowledgeProvider {
  readonly id = QDRANT_ENGINE_ID
  readonly capabilities = QDRANT_CAPABILITIES

  private readonly endpoint: string
  private readonly collection: string
  private readonly apiKey?: string
  private readonly embeddingApiKey: string
  private readonly embeddingModel: string
  private readonly embeddingEndpoint: string
  private readonly label?: string
  private readonly tenantId?: string

  constructor(config: QdrantAdapterConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "")
    this.collection = config.collection
    this.apiKey = config.apiKey
    this.embeddingApiKey = config.embeddingApiKey
    this.embeddingModel = config.embeddingModel
    this.embeddingEndpoint = config.embeddingEndpoint.replace(/\/$/, "")
    this.label = config.label
    this.tenantId = config.tenantId
  }

  /** Force a `tenantId` match when tenant-scoped, ANDed with any caller filter
   *  (Qdrant nests a filter object inside `must`). Returns the caller filter
   *  unchanged in single-tenant mode. The shared collection depends on this. */
  private withTenantScope(
    filter: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (this.tenantId === undefined) return filter
    const tenantClause = { key: "tenantId", match: { value: this.tenantId } }
    return filter ? { must: [tenantClause, filter] } : { must: [tenantClause] }
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
    if (input.kind !== "text" && input.kind !== "url") {
      throw new Error(
        `QdrantKnowledgeAdapter: kind="${input.kind}" not supported by this adapter (only text + url). For file or connector sources, use an engine that owns its own resolver.`,
      )
    }
    const bodyText = await this.loadSourceText(input)
    if (!bodyText.trim()) {
      throw new Error(
        `QdrantKnowledgeAdapter: ingest payload is empty (uri=${input.uri})`,
      )
    }
    const chunks = splitIntoChunks(bodyText)
    const sourceId = cryptoRandomId()
    const indexedAt = new Date().toISOString()

    // Embed in one batched call — keeps round-trips sane for many chunks.
    const vectors = await this.embed(chunks)

    const points = chunks.map((text, idx) => ({
      // Qdrant point IDs must be an unsigned int or a bare UUID — a
      // `${uuid}-${idx}` composite is rejected (400). Each chunk gets its own
      // UUID; grouping/get/delete go through the `source_id` payload filter.
      id: cryptoRandomId(),
      vector: vectors[idx]!,
      payload: {
        source_id: sourceId,
        chunk_index: idx,
        ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
        kind: input.kind,
        uri: input.uri,
        title: input.title,
        text,
        bytes: byteLength(text),
        indexed_at: indexedAt,
        // Preserve caller metadata on every chunk so any returned hit can
        // surface full provenance without a round-trip to canonical sources.
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      } satisfies QdrantPointPayload,
    }))

    await this.qdrantWrite(
      `/collections/${this.collection}/points?wait=true`,
      { method: "PUT", body: { points } },
    )

    return {
      id: sourceId,
      kind: input.kind,
      uri: input.uri,
      title: input.title,
      bytes: chunks.reduce((sum, c) => sum + byteLength(c), 0),
      status: "ready",
      indexedAt: new Date(indexedAt),
      metadata: { chunks: chunks.length },
    } satisfies KnowledgeSource
  }

  async query(q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
    const start = Date.now()
    const [vec] = await this.embed([q.query])
    if (!vec) throw new Error("QdrantKnowledgeAdapter: empty embedding result")

    const limit = q.topK ?? 8
    const body: Record<string, unknown> = {
      vector: vec,
      limit,
      with_payload: true,
      score_threshold: q.minScore,
    }
    const filter = this.withTenantScope(translateFilter(q.filter))
    if (filter) body.filter = filter

    const res = await this.qdrantJson(
      `/collections/${this.collection}/points/search`,
      { method: "POST", body },
      qdrantSearchResponseSchema,
    )

    const hits: KnowledgeHit[] = res.result.map((p) => ({
      sourceId: p.payload.source_id,
      chunkId: String(p.id),
      text: p.payload.text,
      score: p.score,
      // Merge caller-supplied metadata (round-tripped through ingest) with
      // adapter-supplied fields. Caller keys win on collision — corpus
      // provenance (entryPath, qualityScore, temporal, …) must reach the LLM
      // unmangled.
      metadata: {
        title: p.payload.title ?? null,
        uri: p.payload.uri,
        chunkIndex: p.payload.chunk_index,
        ...(p.payload.metadata ?? {}),
      },
    }))

    return {
      engine: this.id,
      // Vector-only adapter — surface the actual mode regardless of the hint so
      // the caller can decide whether to fall back to another engine for
      // graph/hybrid queries.
      modeUsed: "vector",
      hits,
      tookMs: Date.now() - start,
    }
  }

  async listSources(
    filter?: ListSourcesFilter,
  ): Promise<readonly KnowledgeSource[]> {
    // Qdrant has no native group-by — scroll all points, dedupe by source_id,
    // keep the first chunk's metadata. Capped at SCROLL_DEDUPE_CAP so a list
    // call on a million-point collection doesn't pull the whole index. The
    // `kind` / `status` filters are applied client-side after dedupe.
    const seen = new Map<string, KnowledgeSource>()
    let offset: string | number | null = null
    while (seen.size < SCROLL_DEDUPE_CAP) {
      const body: Record<string, unknown> = { limit: 256, with_payload: true }
      const scoped = this.withTenantScope(undefined)
      if (scoped) body.filter = scoped
      if (offset !== null) body.offset = offset
      const res = await this.qdrantJson(
        `/collections/${this.collection}/points/scroll`,
        { method: "POST", body },
        qdrantScrollResponseSchema,
      )
      for (const p of res.result.points) {
        if (p.payload.chunk_index !== 0) continue // collapse to first chunk
        if (seen.has(p.payload.source_id)) continue
        seen.set(p.payload.source_id, {
          id: p.payload.source_id,
          kind: p.payload.kind,
          uri: p.payload.uri,
          title: p.payload.title,
          bytes: p.payload.bytes,
          status: "ready",
          indexedAt: new Date(p.payload.indexed_at),
          metadata: p.payload.metadata ?? {},
        })
      }
      const next = res.result.next_page_offset
      if (next === null || next === undefined) break
      offset = next
    }
    let out = [...seen.values()]
    if (filter?.kind) out = out.filter((s) => s.kind === filter.kind)
    if (filter?.status) out = out.filter((s) => s.status === filter.status)
    return out.slice(0, DEFAULT_LIST_LIMIT)
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const res = await this.qdrantJson(
      `/collections/${this.collection}/points/scroll`,
      {
        method: "POST",
        body: {
          filter: { must: this.sourceIdClause(id) },
          limit: 1,
          with_payload: true,
        },
      },
      qdrantScrollResponseSchema,
    )
    const p = res.result.points[0]
    if (!p) return null
    return {
      id: p.payload.source_id,
      kind: p.payload.kind,
      uri: p.payload.uri,
      title: p.payload.title,
      bytes: p.payload.bytes,
      status: "ready",
      indexedAt: new Date(p.payload.indexed_at),
      metadata: p.payload.metadata ?? {},
    }
  }

  async deleteSource(id: string): Promise<void> {
    await this.qdrantWrite(
      `/collections/${this.collection}/points/delete?wait=true`,
      { method: "POST", body: { filter: { must: this.sourceIdClause(id) } } },
    )
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.endpoint}/collections/${this.collection}`,
        { headers: this.qdrantHeaders() },
      )
      return res.ok
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    // No connections to tear down — REST + fetch. Kept on the interface for
    // adapters that hold long-lived clients.
  }

  // ── Internal: filter clauses ─────────────────────────────────────

  /** The `must[]` clause matching a source id, tenant-scoped when configured. */
  private sourceIdClause(id: string): Record<string, unknown>[] {
    const clauses: Record<string, unknown>[] = [
      { key: "source_id", match: { value: id } },
    ]
    if (this.tenantId !== undefined) {
      clauses.push({ key: "tenantId", match: { value: this.tenantId } })
    }
    return clauses
  }

  // ── Internal: embeddings ─────────────────────────────────────────

  private async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await fetch(`${this.embeddingEndpoint}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.embeddingApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.embeddingModel, input: texts }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `QdrantKnowledgeAdapter: embeddings call failed ${res.status}: ${detail.slice(0, 300)}`,
      )
    }
    const parsed = embeddingsResponseSchema.parse(await res.json())
    const vecs = (parsed.data ?? []).map((d) => d.embedding)
    if (vecs.length !== texts.length) {
      throw new Error(
        `QdrantKnowledgeAdapter: embeddings count mismatch (got ${vecs.length}, want ${texts.length})`,
      )
    }
    return vecs
  }

  // ── Internal: Qdrant REST ────────────────────────────────────────

  /** POST/PUT/DELETE whose response body is not consumed (upsert/delete). */
  private async qdrantWrite(
    path: string,
    opts: { method: "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<void> {
    await this.qdrantFetch(path, opts)
  }

  /** A Qdrant call whose JSON body is parsed with `schema` — nothing untyped
   *  reaches a call site (no `as`). */
  private async qdrantJson<T>(
    path: string,
    opts: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.qdrantFetch(path, opts)
    return schema.parse(await res.json())
  }

  private async qdrantFetch(
    path: string,
    opts: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<Response> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: opts.method,
      headers: this.qdrantHeaders(),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      const labelPart = this.label ? ` (${this.label})` : ""
      throw new Error(
        `QdrantKnowledgeAdapter${labelPart}: ${opts.method} ${path} → ${res.status} ${detail.slice(0, 300)}`,
      )
    }
    return res
  }

  private qdrantHeaders(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" }
    if (this.apiKey) h["api-key"] = this.apiKey
    return h
  }

  // ── Internal: source loading ─────────────────────────────────────

  private async loadSourceText(input: KnowledgeIngestInput): Promise<string> {
    if (input.kind === "text") {
      if (typeof input.content !== "string" || input.content.length === 0) {
        throw new Error(
          `QdrantKnowledgeAdapter: kind="text" requires non-empty content`,
        )
      }
      return input.content
    }
    // kind === "url"
    const res = await fetch(input.uri, {
      headers: { "user-agent": "agentproto-knowledge-qdrant/1.0" },
    })
    if (!res.ok) {
      throw new Error(
        `QdrantKnowledgeAdapter: fetch ${input.uri} failed ${res.status}`,
      )
    }
    return await res.text()
  }
}

// ── Filter translation (exported for testing) ────────────────────────

const qdrantMatchSchema = z.union([
  z.object({ value: z.unknown() }),
  z.object({ any: z.array(z.unknown()) }),
])

const qdrantRangeSchema = z.object({
  gt: z.number().optional(),
  gte: z.number().optional(),
  lt: z.number().optional(),
  lte: z.number().optional(),
})

const qdrantFilterClauseSchema = z.object({
  key: z.string(),
  match: qdrantMatchSchema.optional(),
  range: qdrantRangeSchema.optional(),
})

const qdrantFilterSchema = z.object({
  must: z.array(qdrantFilterClauseSchema).optional(),
  should: z.array(qdrantFilterClauseSchema).optional(),
  must_not: z.array(qdrantFilterClauseSchema).optional(),
})

export type QdrantFilterClause = z.infer<typeof qdrantFilterClauseSchema>
export type QdrantFilter = z.infer<typeof qdrantFilterSchema>

/**
 * Translate a caller-supplied opaque filter map to a Qdrant payload filter.
 *
 * Recognized keys (CorpusFilter shape — see knowledge-engine `types.ts`):
 *   - status:           string | string[]  → must match (any) on metadata.corpus.status
 *   - kind:             string | string[]  → must match (any) on metadata.corpus.kind
 *   - domain:           string | string[]  → must match metadata.corpus.domain
 *   - channel:          string | string[]  → must match metadata.corpus.channel
 *   - minQualityScore:  number             → range gte on metadata.corpus.qualityScore
 *   - maxRiskScore:     number             → range lte on metadata.corpus.riskScore
 *   - mentionedSince:   ISO string         → range gte on metadata.corpus.temporal.lastSeen
 *
 * Unknown keys are dropped (the adapter is vector-only; arbitrary nested
 * predicates aren't worth the complexity at this layer — callers can
 * post-filter on `.metadata` if they need more). Reserved keys (`must`,
 * `should`, `must_not`) pass through verbatim so power users can hand-craft.
 */
export function translateFilter(
  raw: Readonly<Record<string, unknown>> | undefined,
): QdrantFilter | undefined {
  if (!raw) return undefined
  // Hand-crafted Qdrant filter: validate the clause shape so an arbitrary
  // object can't reach the wire untyped. Unknown top-level keys (anything
  // other than must / should / must_not) are stripped by the schema.
  if ("must" in raw || "should" in raw || "must_not" in raw) {
    return qdrantFilterSchema.parse(raw)
  }
  const must: QdrantFilterClause[] = []

  const eqClause = (key: string, value: unknown): void => {
    if (Array.isArray(value)) must.push({ key, match: { any: value } })
    else if (value !== undefined && value !== null)
      must.push({ key, match: { value } })
  }

  // CorpusFilter convention: corpus metadata is stored verbatim under
  // `metadata.*` per the ingest path. Qdrant supports dotted-path keys, so we
  // target nested fields directly.
  if ("status" in raw) eqClause("metadata.corpus.status", raw.status)
  if ("kind" in raw) eqClause("metadata.corpus.kind", raw.kind)
  if ("domain" in raw) eqClause("metadata.corpus.domain", raw.domain)
  if ("channel" in raw) eqClause("metadata.corpus.channel", raw.channel)
  if (typeof raw.minQualityScore === "number") {
    must.push({
      key: "metadata.corpus.qualityScore",
      range: { gte: raw.minQualityScore },
    })
  }
  if (typeof raw.maxRiskScore === "number") {
    must.push({
      key: "metadata.corpus.riskScore",
      range: { lte: raw.maxRiskScore },
    })
  }
  if (typeof raw.mentionedSince === "string") {
    must.push({
      key: "metadata.corpus.temporal.lastSeen",
      range: { gte: Date.parse(raw.mentionedSince) },
    })
  }

  return must.length > 0 ? { must } : undefined
}

// ── helpers ──────────────────────────────────────────────────────────

/** UTF-8 byte length without a `node:buffer` edge — runs on edge runtimes too. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function cryptoRandomId(): string {
  // Prefer the platform crypto (Web Crypto in workers/edge; node exposes the
  // same global) rather than importing node:crypto.
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  // Fallback — 12 random hex chars. Collision probability is fine for
  // per-call source ids inside a collection.
  let out = ""
  for (let i = 0; i < 12; i++) {
    out += Math.floor(Math.random() * 16).toString(16)
  }
  return out
}
