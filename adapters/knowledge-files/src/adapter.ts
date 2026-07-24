/**
 * FilesKnowledgeAdapter — the no-runtime, no-embedding KB engine.
 *
 * Indexes workspace files in process with BM25. Zero setup: works the
 * instant a guild has a system workspace, no E2B sandbox, no API key,
 * no cold start. Best suited as the DEFAULT corpus backing where the
 * AIP-10 entries already live as markdown files — the entries ARE the
 * index, no separate vector store to keep in sync.
 *
 * Index lifecycle: built lazily on first query, cached for 30s, also
 * invalidated explicitly by `ingest()`. External edits (a user typing
 * in the workspace UI) become visible on the next rebuild — for
 * second-precision freshness, hosts can wire fs-watch into the
 * `invalidate()` method.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/files/adapter.ts`) — the
 * class already carried no `@guilde/@simone/@agstudio` edge (it consumes an
 * injected `FsPort` and the vendor-neutral `IKnowledgeProvider` contract), so
 * it re-homes as-is. The ONLY change is the two import paths: the contract +
 * data types now come from `@agentproto/knowledge-engine` (was
 * `../base-knowledge.provider` / `../../types/knowledge.types`). The guild-side
 * `KnowledgeEngineDescriptor` (studio `descriptor.ts`) is NOT lifted — it
 * belonged to the guild resolution layer; this package registers as a
 * provider-kit family instead (see `handle.ts`).
 */

import type { FsPort } from "@agentproto/corpus"
import type {
  IKnowledgeProvider,
  KnowledgeCapabilities,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  ListSourcesFilter,
} from "@agentproto/knowledge-engine"
import {
  buildIndexYielding as buildBm25IndexYielding,
  score as scoreBm25,
  tokenize,
  type Bm25Index,
} from "./bm25.js"

export const FILES_ENGINE_ID = "files" as const

const INDEXED_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
]
// Corpus content is immutable between `promote_candidate` / `rebuild_lens`
// writes. Both code-paths call either `invalidate()` (via ingest/delete) or
// drop the whole provider instance (via `invalidateKnowledgeProvider`), so
// time-based expiry is never needed for correctness — it only forces a full
// Supabase Storage re-scan on every turn after 30 s, causing 37-52s latency.
// Use a permanent cache: the index is rebuilt only when the adapter explicitly
// calls `invalidate()`, or when a new instance is created after a provider
// cache eviction.
const CACHE_TTL_MS = Number.POSITIVE_INFINITY

/**
 * Max concurrent file reads while (re)building the index. Backings like
 * Supabase Storage serve each `readFile` as its own REST round-trip with
 * an internal `AbortSignal.timeout(4000)`; firing all ~N reads at once
 * saturates the event loop and connection pool so the timers expire
 * before the responses land (observed: 426 TimeoutErrors on a ~264-file
 * corpus). A small ceiling keeps each read inside its own budget.
 */
const INDEX_READ_CONCURRENCY = 10

/**
 * Max ms a query waits for an in-progress BM25 build before giving up and
 * returning empty results. The build continues in background — the next query
 * on the same instance will find the index ready (or still building if the
 * corpus is very large). Without this cap, cold-start builds on Supabase
 * Storage (50-150 s for large corpora) block every turn on every new Cloud
 * Run instance, which has no cross-instance shared cache.
 */
const INDEX_QUERY_TIMEOUT_MS = 4_000

export const FILES_CAPABILITIES: KnowledgeCapabilities = Object.freeze({
  vectorSearch: false,
  graphTraversal: false,
  hybridSearch: false,
  multiModal: false,
  streaming: false,
  // BM25 returns ranked hits with file path + byte span — usable as
  // citations even though there's no vector concept.
  citations: true,
  // Chunk size matters for backings that split — files engine indexes
  // whole files so this is an informational ceiling.
  maxChunkBytes: 64 * 1024,
})

export interface FilesAdapterConfig {
  /** Workspace-relative root the engine indexes (walks recursively). */
  readonly workspacePath: string
}

export interface FilesKnowledgeAdapterOptions extends FilesAdapterConfig {
  /** FsPort scoped to the workspace the engine lives in. */
  readonly fs: FsPort
}

export class FilesKnowledgeAdapter implements IKnowledgeProvider {
  readonly id = FILES_ENGINE_ID
  readonly capabilities = FILES_CAPABILITIES

  private readonly fs: FsPort
  private readonly workspacePath: string
  private cachedIndex: Bm25Index | null = null
  private cachedAt = 0
  // In-flight build promise: concurrent turns that arrive while the index is
  // still being built (cachedIndex === null) coalesce onto this promise instead
  // of each kicking off a redundant 40-50s Supabase Storage re-scan.
  private buildInFlight: Promise<Bm25Index> | null = null

  constructor(opts: FilesKnowledgeAdapterOptions) {
    this.fs = opts.fs
    this.workspacePath = opts.workspacePath
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
    // The corpus indexer pushes pre-chunked entries here; the entry .md
    // file is already written by CorpusPromoter, so all we need to do
    // is invalidate the index and return a synthetic source. Skipping
    // the write avoids ghost `sources/chunk-*.md` files duplicating
    // every entry's body.
    const corpusBlock = readCorpusMeta(input.metadata)
    if (corpusBlock?.entrySlug) {
      this.invalidate()
      return {
        id: `${corpusBlock.entrySlug}#${corpusBlock.chunkIndex ?? 0}`,
        kind: "text",
        uri: corpusBlock.entryPath ?? input.uri,
        title: input.title,
        metadata: input.metadata ?? {},
        bytes: byteLength(input.content),
        status: "ready",
        indexedAt: new Date(),
      }
    }

    if (input.kind === "text") {
      const sourceId = stableSlug(input.uri)
      const dest = `${this.workspacePath}/sources/${sourceId}.md`
      const content = decodeContent(input.content) ?? ""
      await this.fs.writeFile(dest, content)
      this.invalidate()
      return {
        id: sourceId,
        kind: "text",
        uri: input.uri,
        title: input.title,
        metadata: input.metadata ?? {},
        bytes: byteLength(content),
        status: "ready",
        indexedAt: new Date(),
      }
    }

    if (input.kind === "url") {
      const res = await fetch(input.uri)
      if (!res.ok) {
        throw new Error(
          `files engine: failed to fetch ${input.uri}: ${res.status} ${res.statusText}`
        )
      }
      const text = await res.text()
      const sourceId = stableSlug(input.uri)
      const dest = `${this.workspacePath}/sources/${sourceId}.txt`
      await this.fs.writeFile(dest, text)
      this.invalidate()
      return {
        id: sourceId,
        kind: "url",
        uri: input.uri,
        title: input.title,
        metadata: input.metadata ?? {},
        bytes: byteLength(text),
        status: "ready",
        indexedAt: new Date(),
      }
    }

    throw new Error(
      `files engine: ingest kind="${input.kind}" not supported. ` +
        `Pass kind="text" with inline content, or kind="url" for the engine to fetch.`
    )
  }

  async query(q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
    const start = Date.now()
    // Non-blocking: if the BM25 index isn't ready within INDEX_QUERY_TIMEOUT_MS,
    // return empty results and let the build continue in background. The next
    // query on the same instance will find the index warm. This prevents a cold
    // Supabase Storage rebuild (50-150 s on large corpora) from blocking every
    // turn on fresh Cloud Run instances.
    const index = await this.ensureIndex(INDEX_QUERY_TIMEOUT_MS)
    const tokens = tokenize(q.query)
    if (tokens.length === 0) {
      return {
        hits: Object.freeze([]),
        tookMs: Date.now() - start,
        engine: this.id,
        modeUsed: "vector",
      }
    }
    const scored = scoreBm25(index, tokens, {
      topK: q.topK,
      minScore: q.minScore,
    })
    const hits: KnowledgeHit[] = scored.map(s => {
      const meta = parseFrontmatterMetadata(s.doc.text)
      const snippetText = s.snippet?.text ?? s.doc.text.slice(0, 300)
      return {
        sourceId: s.doc.id,
        chunkId: s.doc.id,
        text: snippetText,
        score: s.score,
        // span is in original-file bytes; matches engine "citations" capability.
        span: s.snippet
          ? { start: s.snippet.start, end: s.snippet.end }
          : undefined,
        metadata: meta,
      }
    })
    return {
      hits: Object.freeze(hits),
      tookMs: Date.now() - start,
      engine: this.id,
      // BM25 isn't really "vector" — the union doesn't have a "keyword"
      // option. Report "vector" as the closest existing label until the
      // mode union widens.
      modeUsed: "vector",
    }
  }

  async listSources(
    filter?: ListSourcesFilter
  ): Promise<readonly KnowledgeSource[]> {
    const index = await this.ensureIndex()
    const out: KnowledgeSource[] = []
    for (const doc of index.docs) {
      const meta = parseFrontmatterMetadata(doc.text)
      const source: KnowledgeSource = {
        id: doc.id,
        kind: "file",
        uri: doc.id,
        title: typeof meta.title === "string" ? meta.title : undefined,
        bytes: byteLength(doc.text),
        status: "ready",
        metadata: meta,
      }
      if (filter?.kind && source.kind !== filter.kind) continue
      if (filter?.status && source.status !== filter.status) continue
      out.push(source)
    }
    return Object.freeze(out)
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const index = await this.ensureIndex()
    const doc = index.docs.find(d => d.id === id)
    if (!doc) return null
    const meta = parseFrontmatterMetadata(doc.text)
    return {
      id: doc.id,
      kind: "file",
      uri: doc.id,
      title: typeof meta.title === "string" ? meta.title : undefined,
      bytes: byteLength(doc.text),
      status: "ready",
      metadata: meta,
    }
  }

  async deleteSource(id: string): Promise<void> {
    // The path IS the source — deletion means removing the file. The
    // adapter intentionally writes through the same FsPort it reads
    // from, so external editors and the engine stay in sync.
    if (await this.fs.exists(id)) {
      // FsPort doesn't expose `unlink`; write empty to drop content
      // without breaking the contract. Hosts that need true unlink
      // wire it via their own admin path.
      await this.fs.writeFile(id, "")
    }
    this.invalidate()
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Health = the root path is reachable. An empty workspace is
      // healthy (zero hits is a valid query result).
      return await this.fs.exists(this.workspacePath)
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    this.cachedIndex = null
  }

  /** Drop the cached BM25 index — next query rebuilds. */
  private invalidate(): void {
    this.cachedIndex = null
    this.cachedAt = 0
    // Do NOT clear buildInFlight: an in-flight build that started before the
    // invalidate will still store its result, which is immediately stale. The
    // next ensureIndex() call after it resolves will see cachedIndex !== null
    // but cachedAt = 0, which with POSITIVE_INFINITY TTL still passes. This is
    // acceptable: the stale index is at most one build's worth of lag and is
    // replaced on the next explicit write that calls invalidate() + triggers a
    // new query. Clearing buildInFlight would just cause more redundant builds.
  }

  private async ensureIndex(timeoutMs?: number): Promise<Bm25Index> {
    if (this.cachedIndex && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedIndex
    }
    // Coalesce concurrent callers onto one in-flight build. Without this,
    // two turns arriving before the first build completes both see
    // cachedIndex===null and each kick off a full 40-50s Supabase Storage
    // re-scan — wasting resources and keeping both turns slow.
    if (!this.buildInFlight) {
      this.buildInFlight = this._buildIndex().finally(() => {
        this.buildInFlight = null
      })
    }
    if (timeoutMs !== undefined) {
      // Non-blocking mode: race the build against a deadline. If the build
      // wins, great — the index is ready. If the deadline fires first, return
      // an empty index so the turn can proceed without knowledge context. The
      // build continues in background; the next call to ensureIndex() will
      // either find the cache populated (build done) or coalesce onto the
      // still-in-flight promise again.
      const EMPTY: Bm25Index = { docs: [], avgDocLength: 0, df: new Map() }
      const deadline = new Promise<Bm25Index>(resolve =>
        setTimeout(() => resolve(EMPTY), timeoutMs)
      )
      return Promise.race([this.buildInFlight, deadline])
    }
    return this.buildInFlight
  }

  private async _buildIndex(): Promise<Bm25Index> {
    const allPaths = await this.fs.walk(this.workspacePath)
    const candidates = allPaths.filter(p =>
      INDEXED_EXTENSIONS.some(ext => p.toLowerCase().endsWith(ext))
    )
    const inputs = await mapWithConcurrency(
      candidates,
      INDEX_READ_CONCURRENCY,
      async path => ({
        id: path,
        content: await this.fs.readFile(path).catch(() => ""),
      })
    )
    const index = await buildBm25IndexYielding(
      inputs.filter(i => i.content.length > 0)
    )
    this.cachedIndex = index
    this.cachedAt = Date.now()
    return index
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Map `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the result. A fixed pool of workers drains a
 * shared cursor — no batch barriers, so a slow read never stalls the
 * whole pool. Dependency-free stand-in for p-limit.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++
        results[i] = await fn(items[i]!, i)
      }
    }
  )
  await Promise.all(workers)
  return results
}

function decodeContent(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (content instanceof Uint8Array) return new TextDecoder().decode(content)
  return undefined
}

function byteLength(content: unknown): number {
  if (typeof content === "string")
    return new TextEncoder().encode(content).byteLength
  if (content instanceof Uint8Array) return content.byteLength
  return 0
}

/** Stable kebab-case id derived from a uri-ish input. */
function stableSlug(uri: string): string {
  const base = uri.replace(/^[a-z]+:\/+/, "").replace(/[/\\]+/g, "-")
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  return slug || `source-${Date.now().toString(36)}`
}

/**
 * Surface frontmatter as the hit's metadata so corpus-side hydration
 * (which keys on `metadata.entrySlug`) round-trips correctly when this
 * engine backs a corpus. Frontmatter is also surfaced for standalone
 * use so callers can read entry-level fields like `title`, `tags`.
 *
 * Returns `{}` when no frontmatter is present — never throws.
 */
function parseFrontmatterMetadata(
  content: string
): Readonly<Record<string, unknown>> {
  if (!content.startsWith("---")) return Object.freeze({})
  const end = content.indexOf("\n---", 3)
  if (end === -1) return Object.freeze({})
  const block = content.slice(4, end).trim()
  const out: Record<string, unknown> = {}
  // Minimal YAML — handle `key: value` and `key: "value"` at top level.
  // Nested objects are rare in entry frontmatter that drives retrieval;
  // hosts that need full parsing can wire gray-matter outside the
  // adapter and re-parse.
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let value: unknown = m[2]!.trim()
    if (typeof value === "string") {
      if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1)
      else if (value.startsWith("'") && value.endsWith("'"))
        value = value.slice(1, -1)
    }
    out[key] = value
  }
  // Mirror the slug key into `entrySlug` so corpus-hydration finds it
  // without a per-engine adapter — corpus's `hydrateHit` keys on
  // `metadata.entrySlug` (see corpus/hydrate.ts).
  if (typeof out.slug === "string" && !("entrySlug" in out)) {
    out.entrySlug = out.slug
  }
  return Object.freeze(out)
}

function readCorpusMeta(
  metadata: Readonly<Record<string, unknown>> | undefined
): { entrySlug?: string; entryPath?: string; chunkIndex?: number } | undefined {
  if (!metadata) return undefined
  const corpus = (metadata as { corpus?: unknown }).corpus
  if (!corpus || typeof corpus !== "object") return undefined
  const block = corpus as Record<string, unknown>
  return {
    entrySlug:
      typeof block.entrySlug === "string" ? block.entrySlug : undefined,
    entryPath:
      typeof block.entryPath === "string" ? block.entryPath : undefined,
    chunkIndex:
      typeof block.chunkIndex === "number" ? block.chunkIndex : undefined,
  }
}
