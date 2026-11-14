/**
 * FilesKnowledgeAdapter — the no-runtime, no-embedding KB engine.
 *
 * Indexes workspace files with BM25. Zero setup: works the instant a guild
 * has a system workspace, no E2B sandbox, no API key, no cold start. Best
 * suited as the DEFAULT corpus backing where the AIP-10 entries already live
 * as markdown files: the entries ARE the index, no separate vector store to
 * keep in sync.
 *
 * Two index engines, picked per adapter:
 *
 * - **On disk (FTS5)** when `indexPath` is set and the runtime has
 *   `node:sqlite` with FTS5 (Node 22.13+ / 23.4+ / 24+; 22.5-22.12 only with
 *   `--experimental-sqlite`). The index is a SQLite file next to the corpus,
 *   updated per document: `ingest()` upserts that doc's row, `deleteSource()`
 *   empties it, nothing invalidates the whole brain. On open, and then at
 *   most every `reconcileIntervalMs` (checked when a query arrives), a
 *   stat-only scan of the files re-indexes what changed outside the adapter
 *   and drops rows whose file is gone. The first build of a large brain runs
 *   in batches; a query during it answers from what is already indexed with
 *   `partial: true`. Candidates come from FTS5's own `bm25()`, then the top
 *   ones are re-scored with this package's BM25 (k1 1.5, +1 IDF) from their
 *   text, read back from disk anyway for the snippet. No size ceiling.
 * - **In memory** otherwise (no `indexPath`, Node 20, no FTS5, or the on-disk
 *   index failing): the lean BM25 index of bm25.ts, built lazily on first
 *   query, kept until `ingest()` invalidates it. Above `maxIndexDocs` files it
 *   indexes the most recently modified `maxIndexDocs` and flags every result
 *   `partial` instead of refusing.
 *
 * Lifted from the studio integration package
 * (`packages/integration/knowledge/src/providers/files/adapter.ts`), which
 * consumed an injected `FsPort` and the vendor-neutral `IKnowledgeProvider`
 * contract. The guild-side `KnowledgeEngineDescriptor` (studio
 * `descriptor.ts`) is NOT lifted: it belonged to the guild resolution layer;
 * this package registers as a provider-kit family instead (see `handle.ts`).
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
  bm25Idf,
  bm25TermScore,
  makeSnippet,
  score as scoreBm25,
  stripFrontmatter,
  tokenize,
  type Bm25Index,
} from "./bm25.js"
import { openFtsIndex, type FtsIndexHandle } from "./fts-index.js"
import { FTS_MANIFEST_SEP, type FtsManifest } from "./fts-store.js"
import type { WalkStatEntry } from "./local-fs.js"

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

/** Max concurrent `stat` calls of the reconcile scan on a backing without
 *  `walkStat`. */
const SCAN_STAT_CONCURRENCY = 32

/**
 * Max ms a query waits for an in-progress in-memory BM25 build before giving
 * up and returning no hits (flagged `partial`). The build continues in
 * background: the next query on the same instance will find the index ready
 * (or still building if the corpus is very large). Without this cap, cold-start
 * builds on Supabase Storage (50-150 s for large corpora) block every turn on
 * every new Cloud Run instance, which has no cross-instance shared cache. The
 * on-disk index never waits: it answers from what it holds.
 */
const INDEX_QUERY_TIMEOUT_MS = 4_000

/** Docs read, tokenized, and folded into the in-memory index per step of a
 *  build, and the interval at which the build yields to the event loop (see
 *  `buildIndexYielding` in bm25.ts for why the yield matters). Only one
 *  step's text is alive at a time. */
const INDEX_BUILD_STEP = 50

/** Docs read and upserted into the on-disk index per batch (one transaction
 *  in the store). A query waits behind at most one batch. */
const FTS_BUILD_STEP = 100

/**
 * The on-disk index takes FTS5's `bm25()` top candidates, then re-scores them
 * with this package's BM25 from their text: `max(topK * 8, 80)` candidates,
 * at most 300. The two rankings differ in k1 (1.2 vs 1.5) and IDF (FTS5
 * zeroes a term found in more than half the docs, ours keeps it small but
 * positive). On a generated corpus where most terms are that common, the
 * top-10 overlap with the in-memory engine measured 98.1% with 40 candidates,
 * 99.7% with 80, 100% with 120.
 */
const FTS_CANDIDATE_FACTOR = 8
const FTS_MIN_CANDIDATES = 80
const FTS_MAX_CANDIDATES = 300

/** Default gap between two reconcile scans of the on-disk index. A scan is
 *  stat-only (no reads unless a file changed) and runs in the background:
 *  a query that finds the last scan older than this starts one and answers
 *  right away. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000

/**
 * Ceiling on the files the IN-MEMORY engine indexes (the on-disk index has
 * none). Above it, the in-memory engine indexes only the most recently
 * modified `maxIndexDocs` files and flags results `partial`. Measured on
 * 5.8 KB transcript-shaped docs, the lean index costs about 2.4 KB of heap per
 * doc; real brains measured up to 5 KB, so 100,000 docs is about 500 MB
 * resident at worst.
 */
export const DEFAULT_MAX_INDEX_DOCS = 100_000

/**
 * @deprecated No longer thrown: over the ceiling the in-memory engine now
 * indexes the most recent `maxIndexDocs` files and flags results `partial`,
 * and the on-disk engine has no ceiling. Kept so existing imports and
 * `err.name` checks keep compiling.
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
 * One index build (in-memory build, or on-disk build / reconcile) at a time
 * across every adapter in the process. An in-memory build peaks at its index
 * plus one step of file text, so serializing builds keeps the peak to the
 * largest single brain instead of the sum of all of them (a federated query
 * used to build every brain at once); on-disk builds are serialized for the
 * same reason on I/O.
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
  /** Absolute host path of the on-disk index file (SQLite FTS5), e.g.
   *  `<brain>/.index/fts.sqlite`. Keep it out of the walked tree (a hidden
   *  directory is skipped). Absent: in-memory index only. The file is
   *  derived data: deleting it only costs a rebuild. */
  readonly indexPath?: string
  /** Run the on-disk index in a worker thread so SQLite never blocks the
   *  caller's thread. Default true. */
  readonly indexWorker?: boolean
  /** Gap between two reconcile scans of the on-disk index; 0 scans only
   *  when the index is opened. Default {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
  readonly reconcileIntervalMs?: number
  /** In-memory engine only: index at most this many files (the most recently
   *  modified) and flag results `partial` above it. Defaults to
   *  {@link DEFAULT_MAX_INDEX_DOCS}. */
  readonly maxIndexDocs?: number
  /** How long `query()` waits for a cold in-memory build before answering
   *  with no hits, flagged `partial` (the build keeps going). Defaults to
   *  4 s. */
  readonly queryTimeoutMs?: number
  /** Sink for the one-line build / reconcile / timeout logs. Defaults to
   *  `console.log`. */
  readonly log?: (line: string) => void
}

/** A backing that can list files with their size and mtime in one pass
 *  ({@link LocalFs.walkStat}). */
interface StatWalker {
  walkStat(p: string): Promise<readonly WalkStatEntry[]>
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
  private readonly indexPath: string | undefined
  private readonly indexWorker: boolean
  private readonly reconcileIntervalMs: number

  // ── in-memory engine ──
  private cachedIndex: Bm25Index | null = null
  private cachedAt = 0
  // True when the cached index holds only the most recent maxIndexDocs files.
  private cachedPartial = false
  // In-flight build promise: concurrent turns that arrive while the index is
  // still being built (cachedIndex === null) coalesce onto this promise instead
  // of each kicking off a redundant 40-50s Supabase Storage re-scan.
  private buildInFlight: Promise<Bm25Index> | null = null
  private buildStartedAt = 0

  // ── on-disk engine ──
  private ftsOpening: Promise<FtsIndexHandle | null> | null = null
  private ftsHandle: FtsIndexHandle | null = null
  private ftsDisabled = false
  // The index holds every file (a full build finished at least once).
  private ftsComplete = false
  private sync: Promise<void> | null = null
  private syncStartedAt = 0
  private lastSyncAt = 0
  // A reconcile is due on the next query (an external writer was signalled).
  private syncDue = false
  private disposed = false
  // Per-document updates since the last reconcile, for its log line.
  private incrementalUpserts = 0
  private incrementalDeletes = 0

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
    this.indexPath = opts.indexPath
    this.indexWorker = opts.indexWorker ?? true
    this.reconcileIntervalMs =
      typeof opts.reconcileIntervalMs === "number" && opts.reconcileIntervalMs >= 0
        ? opts.reconcileIntervalMs
        : DEFAULT_RECONCILE_INTERVAL_MS
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
      await this.indexWritten(dest, content)
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
      await this.indexWritten(dest, text)
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
    const tokens = tokenize(q.query)
    const fts = await this.openFts()
    if (fts) {
      try {
        return await this.queryFts(fts, q, tokens, start)
      } catch (err) {
        this.disableFts(err)
      }
    }
    // Non-blocking: if the BM25 index isn't ready within INDEX_QUERY_TIMEOUT_MS,
    // return empty results and let the build continue in background. The next
    // query on the same instance will find the index warm. This prevents a cold
    // Supabase Storage rebuild (50-150 s on large corpora) from blocking every
    // turn on fresh Cloud Run instances.
    const index = await this.ensureIndex(this.queryTimeoutMs)
    const partial = index === EMPTY_INDEX || this.cachedPartial
    if (tokens.length === 0) {
      return result([], start, partial)
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
    return result(
      scored.map((s, i) => toHit(s.doc.id, s.score, texts[i]!, tokens)),
      start,
      partial
    )
  }

  async listSources(
    filter?: ListSourcesFilter
  ): Promise<readonly KnowledgeSource[]> {
    const ids = await this.indexedIds()
    // Every source is kind "file" + status "ready": filter before reading.
    if (filter?.kind && filter.kind !== "file") return Object.freeze([])
    if (filter?.status && filter.status !== "ready") return Object.freeze([])
    const out: KnowledgeSource[] = []
    for (let i = 0; i < ids.length; i += INDEX_BUILD_STEP) {
      const step = ids.slice(i, i + INDEX_BUILD_STEP)
      const texts = await mapWithConcurrency(
        step,
        INDEX_READ_CONCURRENCY,
        id => this.readText(id)
      )
      step.forEach((id, j) => out.push(fileSource(id, texts[j]!)))
    }
    return Object.freeze(out)
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const fts = await this.openFts()
    if (fts) {
      try {
        if (!(await fts.request("has", { path: id }))) return null
        return fileSource(id, await this.readText(id))
      } catch (err) {
        this.disableFts(err)
      }
    }
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
      await this.indexWritten(id, "")
      return
    }
    const fts = await this.openFts()
    if (fts) {
      try {
        const { removed } = await fts.request("remove", { paths: [id] })
        this.incrementalDeletes += removed
        return
      } catch (err) {
        this.disableFts(err)
      }
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
    // A running build stops at its next batch (its next request fails once
    // the handle is released, silently since we are disposed).
    this.disposed = true
    const handle = await this.ftsOpening?.catch(() => null)
    this.ftsOpening = null
    this.ftsHandle = null
    await handle?.release()
  }

  /**
   * Resolves once the on-disk index has no build or reconcile running (at
   * once on the in-memory engine). For hosts and tests that need a settled
   * index; queries never need it.
   */
  async whenIndexSynced(): Promise<void> {
    await this.openFts()
    while (this.sync) await this.sync.catch(() => undefined)
  }

  /**
   * Signal that files changed outside the adapter. In memory: drop the index
   * (next query rebuilds). On disk: the next query starts a reconcile scan.
   */
  invalidate(): void {
    this.cachedIndex = null
    this.cachedAt = 0
    this.cachedPartial = false
    this.syncDue = true
    // Do NOT clear buildInFlight: an in-flight build that started before the
    // invalidate will still store its result, which is immediately stale. The
    // next ensureIndex() call after it resolves will see cachedIndex !== null
    // but cachedAt = 0, which with POSITIVE_INFINITY TTL still passes. This is
    // acceptable: the stale index is at most one build's worth of lag and is
    // replaced on the next explicit write that calls invalidate() + triggers a
    // new query. Clearing buildInFlight would just cause more redundant builds.
  }

  // ── on-disk engine ────────────────────────────────────────────────

  /** The on-disk index, opened on first use (which also starts its first
   *  reconcile), or null when this adapter runs in memory. */
  private openFts(): Promise<FtsIndexHandle | null> {
    if (!this.indexPath || this.ftsDisabled || this.disposed) return Promise.resolve(null)
    this.ftsOpening ??= this.doOpenFts(this.indexPath)
    return this.ftsOpening
  }

  private async doOpenFts(indexPath: string): Promise<FtsIndexHandle | null> {
    try {
      const handle = await openFtsIndex({
        path: indexPath,
        worker: this.indexWorker,
        onReset: reason =>
          this.log(
            `[knowledge-files:${this.label}] on-disk index unreadable (${reason}); deleted, rebuilding`
          ),
      })
      const info = await handle.request("info", undefined)
      this.ftsHandle = handle
      this.ftsComplete = info.complete
      this.log(
        `[knowledge-files:${this.label}] on-disk index opened: ${info.docs} docs, ` +
          `${info.complete ? "complete" : "incomplete"}` +
          (info.created === "new" ? ", new file" : "") +
          (info.created === "version" ? ", format changed: rebuilding" : "") +
          `, sqlite ${info.sqliteVersion}, ${handle.inWorker ? "worker thread" : "inline"}`
      )
      this.kickSync()
      return handle
    } catch (err) {
      this.disableFts(err)
      return null
    }
  }

  /** Give up on the on-disk index for this adapter: log once, fall back to
   *  the in-memory engine. */
  private disableFts(err: unknown): void {
    if (this.ftsDisabled) return
    this.ftsDisabled = true
    this.log(
      `[knowledge-files:${this.label}] on-disk index unavailable ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `using the in-memory index (up to ${this.maxIndexDocs} docs)`
    )
    const handle = this.ftsHandle
    this.ftsHandle = null
    this.ftsOpening = null
    void handle?.release().catch(() => undefined)
  }

  /** Start a build / reconcile when one is due, without waiting for it. */
  private kickSync(): void {
    if (this.sync || this.disposed || !this.ftsHandle) return
    const due =
      this.lastSyncAt === 0 ||
      this.syncDue ||
      (this.reconcileIntervalMs > 0 &&
        Date.now() - this.lastSyncAt >= this.reconcileIntervalMs)
    if (!due) return
    const handle = this.ftsHandle
    this.syncDue = false
    this.syncStartedAt = Date.now()
    const run = runExclusiveBuild(() => this.runSync(handle))
      .catch(err => {
        if (this.disposed) return
        this.log(
          `[knowledge-files:${this.label}] on-disk index ${this.ftsComplete ? "reconcile" : "build"} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      })
      .finally(() => {
        this.lastSyncAt = Date.now()
        this.sync = null
      })
    this.sync = run
  }

  /**
   * Bring the on-disk index in line with the files: a stat-only scan, then
   * read and upsert only what is new or changed, batch by batch, and drop
   * rows whose file is gone. The first run over an empty index is the build.
   */
  private async runSync(handle: FtsIndexHandle): Promise<void> {
    const start = Date.now()
    const heapBefore = heapUsedMb()
    const initial = !this.ftsComplete
    const upsertsBefore = this.incrementalUpserts
    const deletesBefore = this.incrementalDeletes
    const mark = await handle.request("mark", undefined)
    const { paths, manifest } = await this.scanManifest()
    const scanMs = Date.now() - start
    const diff = await handle.request("diff", { manifest, mark })
    let bytesRead = 0
    for (let i = 0; i < diff.changed.length; i += FTS_BUILD_STEP) {
      if (this.disposed) return
      await new Promise<void>(resolve => setImmediate(resolve))
      const step = Array.from(diff.changed.subarray(i, i + FTS_BUILD_STEP))
      const texts = await mapWithConcurrency(step, INDEX_READ_CONCURRENCY, k =>
        this.readText(paths[k]!)
      )
      const docs = step.map((k, j) => {
        bytesRead += byteLength(texts[j])
        return {
          path: paths[k]!,
          size: manifest.sizes[k]!,
          mtimeMs: manifest.mtimes[k]!,
          text: texts[j]!,
        }
      })
      await handle.request("upsert", { docs })
    }
    if (initial) {
      await handle.request("setComplete", { complete: true })
      this.ftsComplete = true
    }
    const info = await handle.request("info", undefined)
    const ms = Date.now() - start
    if (initial) {
      this.log(
        `[knowledge-files:${this.label}] index built: ${info.docs} docs, ` +
          `${bytesRead} bytes read, ${ms} ms, heapUsed ${heapBefore} MB -> ${heapUsedMb()} MB ` +
          `(on disk, ${paths.length} files scanned in ${scanMs} ms)`
      )
    } else {
      this.log(
        `[knowledge-files:${this.label}] index reconciled: ${paths.length} files scanned in ${scanMs} ms, ` +
          `${diff.changed.length} re-indexed, ${diff.removed} removed, ${bytesRead} bytes read, ${ms} ms; ` +
          `${upsertsBefore} upserts and ${deletesBefore} deletes applied incrementally since the last reconcile`
      )
      this.incrementalUpserts -= upsertsBefore
      this.incrementalDeletes -= deletesBefore
    }
  }

  /** Every indexable file with its size and mtime, without reading any. */
  private async scanManifest(): Promise<{ paths: string[]; manifest: FtsManifest }> {
    const walker = this.fs as Partial<StatWalker>
    let found: WalkStatEntry[]
    if (typeof walker.walkStat === "function") {
      found = [...(await walker.walkStat(this.workspacePath))]
    } else {
      const listed = await this.fs.walk(this.workspacePath)
      const stats = await mapWithConcurrency(listed, SCAN_STAT_CONCURRENCY, p =>
        this.fs.stat(p).catch(() => null)
      )
      found = []
      listed.forEach((p, i) => {
        const s = stats[i]
        if (s && s.kind === "file") {
          found.push({ path: p, size: s.bytes ?? 0, mtimeMs: mtimeOf(s.modifiedAt) })
        }
      })
    }
    found = found.filter(e => isIndexable(e.path) && !e.path.includes(FTS_MANIFEST_SEP))
    const paths = found.map(e => e.path)
    return {
      paths,
      manifest: {
        paths: paths.join(FTS_MANIFEST_SEP),
        sizes: Float64Array.from(found, e => e.size),
        mtimes: Float64Array.from(found, e => e.mtimeMs),
      },
    }
  }

  /** Update the on-disk row of a file this adapter just wrote; falls back to
   *  invalidating the in-memory index. */
  private async indexWritten(path: string, text: string): Promise<void> {
    const fts = isIndexable(path) ? await this.openFts() : null
    if (fts) {
      try {
        const st = await this.fs.stat(path)
        await fts.request("upsert", {
          docs: [
            {
              path,
              size: st?.bytes ?? byteLength(text),
              mtimeMs: mtimeOf(st?.modifiedAt),
              text,
            },
          ],
        })
        if (text.length > 0) this.incrementalUpserts++
        else this.incrementalDeletes++
        return
      } catch (err) {
        this.disableFts(err)
      }
    }
    this.invalidate()
  }

  private async queryFts(
    fts: FtsIndexHandle,
    q: KnowledgeQuery,
    tokens: readonly string[],
    start: number
  ): Promise<KnowledgeQueryResult> {
    this.kickSync()
    const partial = !this.ftsComplete
    if (tokens.length === 0) return result([], start, partial)
    const topK = q.topK ?? 10
    const minScore = q.minScore ?? 0
    const limit = Math.min(
      FTS_MAX_CANDIDATES,
      Math.max(topK * FTS_CANDIDATE_FACTOR, FTS_MIN_CANDIDATES)
    )
    const found = await fts.request("search", { tokens, limit })
    if (partial) {
      this.log(
        `[knowledge-files:${this.label}] query answered from a partial index: ` +
          `${found.docs} docs indexed so far, first build running for ${Date.now() - this.syncStartedAt} ms`
      )
    }
    // Re-score the candidates with this package's BM25 from their text (read
    // anyway for the snippet), so the ranking is the in-memory engine's.
    const texts = await mapWithConcurrency(
      found.candidates,
      INDEX_READ_CONCURRENCY,
      c => this.readText(c.path)
    )
    const avgDocLength = found.avgDocLength === 0 ? 1 : found.avgDocLength
    const idf = new Map<string, number>()
    for (const t of tokens) {
      const n = found.df[t] ?? 0
      if (n > 0) idf.set(t, bm25Idf(found.docs, n))
    }
    const scored: Array<{ i: number; score: number }> = []
    found.candidates.forEach((_, i) => {
      const docTokens = tokenize(stripFrontmatter(texts[i]!))
      const tf = new Map<string, number>()
      for (const t of docTokens) if (idf.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1)
      let s = 0
      for (const t of tokens) {
        const f = tf.get(t)
        if (!f) continue
        s += bm25TermScore(idf.get(t)!, f, docTokens.length, avgDocLength)
      }
      if (s > minScore) scored.push({ i, score: s })
    })
    // Ties keep FTS5's order, which ends on rowid: index insertion order.
    scored.sort((a, b) => b.score - a.score || a.i - b.i)
    const hits = scored
      .slice(0, topK)
      .map(s => toHit(found.candidates[s.i]!.path, s.score, texts[s.i]!, tokens))
    return result(hits, start, partial)
  }

  /** Ids of every indexed doc, from whichever engine serves this adapter. */
  private async indexedIds(): Promise<readonly string[]> {
    const fts = await this.openFts()
    if (fts) {
      try {
        return await fts.request("list", undefined)
      } catch (err) {
        this.disableFts(err)
      }
    }
    const index = await this.ensureIndex()
    return index.docs.map(d => d.id)
  }

  // ── in-memory engine ──────────────────────────────────────────────

  private async ensureIndex(timeoutMs?: number): Promise<Bm25Index> {
    if (this.cachedIndex && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedIndex
    }
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
    let candidates = allPaths.filter(isIndexable)
    let partial = false
    if (candidates.length > this.maxIndexDocs) {
      // Over the ceiling: index the most recently modified files only, and
      // say so on every result, instead of refusing the search.
      const total = candidates.length
      candidates = await this.mostRecent(candidates, this.maxIndexDocs)
      partial = true
      this.log(
        `[knowledge-files:${this.label}] index capped: ${total} indexable files exceed the ` +
          `in-memory ceiling of ${this.maxIndexDocs}; indexing the ${candidates.length} most recent, ` +
          `results flagged partial`
      )
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
    this.cachedPartial = partial
    this.log(
      `[knowledge-files:${this.label}] index built: ${index.docs.length} docs, ` +
        `${bytesRead} bytes read, ${Date.now() - start} ms, ` +
        `heapUsed ${heapBefore} MB -> ${heapUsedMb()} MB`
    )
    return index
  }

  /** The `limit` most recently modified of `paths`, kept in walk order. */
  private async mostRecent(paths: readonly string[], limit: number): Promise<string[]> {
    const stats = await mapWithConcurrency(paths, SCAN_STAT_CONCURRENCY, p =>
      this.fs.stat(p).catch(() => null)
    )
    const order = paths.map((_, i) => i)
    order.sort((a, b) => mtimeOf(stats[b]?.modifiedAt) - mtimeOf(stats[a]?.modifiedAt) || a - b)
    const keep = new Set(order.slice(0, limit))
    return paths.filter((_, i) => keep.has(i))
  }

  /** A doc's current text, or "" when it can no longer be read. */
  private readText(id: string): Promise<string> {
    return this.fs.readFile(id).catch(() => "")
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const EMPTY_INDEX = new Bm25IndexBuilder().finish()

function isIndexable(path: string): boolean {
  const lower = path.toLowerCase()
  return INDEXED_EXTENSIONS.some(ext => lower.endsWith(ext))
}

/** A stat's mtime in whole ms, 0 when unknown. */
function mtimeOf(date: Date | undefined): number {
  return date ? Math.trunc(date.getTime()) : 0
}

function result(
  hits: KnowledgeHit[],
  start: number,
  partial: boolean
): KnowledgeQueryResult {
  return {
    hits: Object.freeze(hits),
    tookMs: Date.now() - start,
    engine: FILES_ENGINE_ID,
    // BM25 isn't really "vector": the union doesn't have a "keyword"
    // option. Report "vector" as the closest existing label until the
    // mode union widens.
    modeUsed: "vector",
    ...(partial ? { partial: true } : {}),
  }
}

/** A hit for doc `id` with its current `text`: snippet, byte span, and the
 *  file's frontmatter as metadata. */
function toHit(
  id: string,
  score: number,
  text: string,
  tokens: readonly string[]
): KnowledgeHit {
  const snippet = makeSnippet(text, tokens)
  return {
    sourceId: id,
    chunkId: id,
    text: snippet.text,
    score,
    // span is in original-file bytes; matches engine "citations" capability.
    span: { start: snippet.start, end: snippet.end },
    metadata: parseFrontmatterMetadata(text),
  }
}

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
