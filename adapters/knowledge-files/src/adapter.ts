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
import {
  KnowledgeNotSupportedError,
  type IKnowledgeProvider,
  type KnowledgeCapabilities,
  type KnowledgeHit,
  type KnowledgeIngestInput,
  type KnowledgeQuery,
  type KnowledgeQueryResult,
  type KnowledgeSource,
  type ListSourcesFilter,
  type KnowledgeProvenance,
} from "@agentproto/knowledge-engine"
import {
  Bm25IndexBuilder,
  makeSnippet,
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

/** Docs read, tokenized, and folded into the index per step of a build, and
 *  the interval at which the build yields to the event loop (see
 *  `buildIndexYielding` in bm25.ts for why the yield matters). Only one
 *  step's text is alive at a time. */
const INDEX_BUILD_STEP = 50

/**
 * Default ceiling on the files a brain may index in process. Above it the
 * engine refuses to build and every query fails with
 * {@link FilesIndexTooLargeError}. Measured on 5.8 KB transcript-shaped docs:
 * the lean index costs about 2.4 KB of heap per doc where the old one (text
 * plus a per-doc `tf` Map) cost about 20 KB. Real brains measured 40 KB per doc
 * on the old shape, so budget about 5 KB per doc: 100,000 docs is about
 * 500 MB resident at worst. That covers the 47k and 91k doc brains seen in the
 * field and refuses the 223k one, which wants a real engine (qdrant,
 * gbrain-doc) rather than a whole-corpus scan per query.
 */
export const DEFAULT_MAX_INDEX_DOCS = 100_000

/**
 * Thrown by `query()` / `listSources()` / `getSource()` when the brain holds
 * more indexable files than the configured ceiling. The name is the stable
 * signal (`err.name === "FilesIndexTooLargeError"`) so a second copy of this
 * package in the tree still matches.
 */
export class FilesIndexTooLargeError extends Error {
  readonly docCount: number
  readonly maxDocs: number

  constructor(label: string, docCount: number, maxDocs: number) {
    super(
      `files engine (${label}): refusing to build the in-process index: ` +
        `${docCount} indexable files exceed the ceiling of ${maxDocs}. ` +
        `Raise maxIndexDocs, or back this brain with a real search engine.`
    )
    this.name = "FilesIndexTooLargeError"
    this.docCount = docCount
    this.maxDocs = maxDocs
  }
}

/**
 * One index build at a time across every adapter in the process. A build
 * peaks at its index plus one step of file text, so serializing builds keeps
 * the peak to the largest single brain instead of the sum of all of them
 * (a federated query used to build every brain at once).
 */
let buildGate: Promise<unknown> = Promise.resolve()
let buildsRunning = 0
function runExclusiveBuild<T>(fn: () => Promise<T>): Promise<T> {
  const run = buildGate.then(async () => {
    buildsRunning++
    try {
      return await fn()
    } finally {
      buildsRunning--
    }
  })
  buildGate = run.catch(() => undefined)
  return run
}

/** Index builds running right now, process wide (0 or 1). For tests. */
export function filesIndexBuildsRunning(): number {
  return buildsRunning
}

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
  /** Name used in log lines and errors (e.g. the brain's workspace slug).
   *  Defaults to `workspacePath`. */
  readonly label?: string
  /** Refuse to build the index above this many indexable files. Defaults to
   *  {@link DEFAULT_MAX_INDEX_DOCS}. */
  readonly maxIndexDocs?: number
  /** How long `query()` waits for a cold build before answering with no
   *  hits (the build keeps going). Defaults to 4 s. */
  readonly queryTimeoutMs?: number
  /** Sink for the one-line build / timeout / refusal logs. Defaults to
   *  `console.log`. */
  readonly log?: (line: string) => void
}

export class FilesKnowledgeAdapter implements IKnowledgeProvider {
  readonly id = FILES_ENGINE_ID
  readonly capabilities = FILES_CAPABILITIES

  private readonly fs: FsPort
  private readonly workspacePath: string
  private readonly label: string
  private readonly maxIndexDocs: number
  private readonly queryTimeoutMs: number
  private readonly log: (line: string) => void
  private cachedIndex: Bm25Index | null = null
  private cachedAt = 0
  // In-flight build promise: concurrent turns that arrive while the index is
  // still being built (cachedIndex === null) coalesce onto this promise instead
  // of each kicking off a redundant 40-50s Supabase Storage re-scan.
  private buildInFlight: Promise<Bm25Index> | null = null
  private buildStartedAt = 0
  // A refused build (over the ceiling) is remembered until the next
  // invalidate(), so repeated queries do not re-walk a huge brain.
  private refusal: FilesIndexTooLargeError | null = null

  constructor(opts: FilesKnowledgeAdapterOptions) {
    this.fs = opts.fs
    this.workspacePath = opts.workspacePath
    this.label = opts.label ?? opts.workspacePath
    this.maxIndexDocs =
      typeof opts.maxIndexDocs === "number" && opts.maxIndexDocs > 0
        ? opts.maxIndexDocs
        : DEFAULT_MAX_INDEX_DOCS
    this.queryTimeoutMs = opts.queryTimeoutMs ?? INDEX_QUERY_TIMEOUT_MS
    this.log = opts.log ?? (line => console.log(line))
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
    const index = await this.ensureIndex(this.queryTimeoutMs)
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
    // The index holds no text: read the top-K files back for their snippet
    // and frontmatter. A file that vanished since the build yields an empty
    // snippet rather than failing the whole query.
    const texts = await mapWithConcurrency(
      scored,
      INDEX_READ_CONCURRENCY,
      s => this.readText(s.doc.id)
    )
    const hits: KnowledgeHit[] = scored.map((s, i) => {
      const text = texts[i]!
      const meta = parseFrontmatterMetadata(text)
      const snippet = makeSnippet(text, tokens)
      return {
        sourceId: s.doc.id,
        chunkId: s.doc.id,
        text: snippet.text,
        score: s.score,
        // span is in original-file bytes; matches engine "citations" capability.
        span: { start: snippet.start, end: snippet.end },
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
    // Every source is kind "file" + status "ready": filter before reading.
    if (filter?.kind && filter.kind !== "file") return Object.freeze([])
    if (filter?.status && filter.status !== "ready") return Object.freeze([])
    const out: KnowledgeSource[] = []
    for (let i = 0; i < index.docs.length; i += INDEX_BUILD_STEP) {
      const step = index.docs.slice(i, i + INDEX_BUILD_STEP)
      const texts = await mapWithConcurrency(
        step,
        INDEX_READ_CONCURRENCY,
        doc => this.readText(doc.id)
      )
      step.forEach((doc, j) => out.push(fileSource(doc.id, texts[j]!)))
    }
    return Object.freeze(out)
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const index = await this.ensureIndex()
    const doc = index.docs.find(d => d.id === id)
    if (!doc) return null
    return fileSource(doc.id, await this.readText(doc.id))
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

  async supersede(_id: string, _by?: string): Promise<void> {
    throw new KnowledgeNotSupportedError(
      this.id,
      "supersede",
      "plain files carry no lifecycle status; use the corpus adapter over an AIP-10 workspace",
    )
  }

  async explain(id: string): Promise<KnowledgeProvenance | null> {
    const source = await this.getSource(id)
    if (!source) return null
    // A file's provenance is its path and own frontmatter; there is no
    // upstream-derivation or audit chain at this layer.
    return {
      sourceId: source.id,
      derivedFrom: [],
      metadata: { uri: source.uri, ...source.metadata },
    }
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
    this.refusal = null
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
    if (this.refusal) throw this.refusal
    // Coalesce concurrent callers onto one in-flight build. Without this,
    // two turns arriving before the first build completes both see
    // cachedIndex===null and each kick off a full 40-50s Supabase Storage
    // re-scan — wasting resources and keeping both turns slow.
    if (!this.buildInFlight) {
      this.buildStartedAt = Date.now()
      const build = runExclusiveBuild(() => this._buildIndex()).finally(() => {
        this.buildInFlight = null
      })
      // A caller that gave up at its deadline no longer awaits the build;
      // keep a failure from surfacing as an unhandled rejection.
      build.catch(() => undefined)
      this.buildInFlight = build
    }
    if (timeoutMs !== undefined) {
      // Non-blocking mode: race the build against a deadline. If the build
      // wins, great — the index is ready. If the deadline fires first, return
      // an empty index so the turn can proceed without knowledge context. The
      // build continues in background; the next call to ensureIndex() will
      // either find the cache populated (build done) or coalesce onto the
      // still-in-flight promise again.
      const build = this.buildInFlight
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
      const winner = await Promise.race([build, deadline]).finally(() =>
        clearTimeout(timer)
      )
      if (winner) return winner
      this.log(
        `[knowledge-files:${this.label}] query timed out after ${timeoutMs} ms ` +
          `waiting for the index build (running for ${Date.now() - this.buildStartedAt} ms); ` +
          `returning no hits, the build keeps going`
      )
      return EMPTY_INDEX
    }
    return this.buildInFlight
  }

  private async _buildIndex(): Promise<Bm25Index> {
    const start = Date.now()
    const heapBefore = heapUsedMb()
    const allPaths = await this.fs.walk(this.workspacePath)
    const candidates = allPaths.filter(p =>
      INDEXED_EXTENSIONS.some(ext => p.toLowerCase().endsWith(ext))
    )
    if (candidates.length > this.maxIndexDocs) {
      const refusal = new FilesIndexTooLargeError(
        this.label,
        candidates.length,
        this.maxIndexDocs
      )
      this.refusal = refusal
      this.log(
        `[knowledge-files:${this.label}] index build refused: ` +
          `${candidates.length} indexable files exceed the ceiling of ${this.maxIndexDocs}`
      )
      throw refusal
    }
    // Read, tokenize, and fold in one step at a time, in walk order, so only
    // one step's text is ever alive (the old build held every file's text,
    // then kept it in the index).
    const builder = new Bm25IndexBuilder()
    let bytesRead = 0
    for (let i = 0; i < candidates.length; i += INDEX_BUILD_STEP) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const step = candidates.slice(i, i + INDEX_BUILD_STEP)
      const texts = await mapWithConcurrency(
        step,
        INDEX_READ_CONCURRENCY,
        path => this.fs.readFile(path).catch(() => "")
      )
      step.forEach((path, j) => {
        const content = texts[j]!
        if (content.length === 0) return
        bytesRead += byteLength(content)
        builder.add(path, content)
      })
    }
    const index = builder.finish()
    this.cachedIndex = index
    this.cachedAt = Date.now()
    this.log(
      `[knowledge-files:${this.label}] index built: ${index.docs.length} docs, ` +
        `${bytesRead} bytes read, ${Date.now() - start} ms, ` +
        `heapUsed ${heapBefore} MB -> ${heapUsedMb()} MB`
    )
    return index
  }

  /** A doc's current text, or "" when it can no longer be read. */
  private readText(id: string): Promise<string> {
    return this.fs.readFile(id).catch(() => "")
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const EMPTY_INDEX = new Bm25IndexBuilder().finish()

/** `process.memoryUsage().heapUsed` in MB, or "?" off Node. */
function heapUsedMb(): number | "?" {
  if (typeof process === "undefined" || !process.memoryUsage) return "?"
  return Math.round(process.memoryUsage().heapUsed / (1024 * 1024))
}

/** The {@link KnowledgeSource} for an indexed file and its current text. */
function fileSource(id: string, text: string): KnowledgeSource {
  const meta = parseFrontmatterMetadata(text)
  return {
    id,
    kind: "file",
    uri: id,
    title: typeof meta.title === "string" ? meta.title : undefined,
    bytes: byteLength(text),
    status: "ready",
    metadata: meta,
  }
}

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
