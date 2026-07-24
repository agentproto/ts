/**
 * CorpusAdapterCore — `IKnowledgeProvider` over an AIP-10 corpus
 * workspace, composing with a backing knowledge engine (the files
 * adapter, or an external vector store) for the vector/graph layer.
 *
 * The adapter:
 *   - reads AIP-10 entries/sources directly from the workspace via an
 *     injected FsPort,
 *   - delegates vector queries to a backing engine via its own
 *     `IKnowledgeProvider`,
 *   - hydrates every hit with canonical AIP-10 provenance,
 *   - REJECTS public `ingest()` / `deleteSource()` calls
 *     unconditionally — corpus writes go through `CorpusInternalWriter`,
 *     which is constructed only by the host's corpus-host service.
 *
 * Middleware (default-policy, access-policy, hydrate-cache,
 * ranking-boost, eval-telemetry, empty-state) wraps this core as
 * decorators in later milestones. The core stays minimal so the
 * decoration story is composable.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/corpus/adapter.ts`) — the
 * class already carried no `@guilde/@simone/@agstudio` edge (it consumes an
 * injected `FsPort` + a backing `IKnowledgeProvider` and the vendor-neutral
 * `@agentproto/corpus` access/reader primitives), so it re-homes as-is. The
 * ONLY change is the two import blocks: the `IKnowledgeProvider` contract +
 * data types now come from `@agentproto/knowledge-engine` (was
 * `../base-knowledge.provider` / `../../types/knowledge.types`). The guild-side
 * `KnowledgeEngineDescriptor` (studio `descriptor.ts`) is NOT lifted — it
 * belonged to the guild resolution layer; this package registers as a
 * provider-kit family instead (see `handle.ts`).
 */

import {
  CorpusWorkspaceReader,
  evaluateAccess,
  readAccessSpec,
  type AccessCaller,
  type AccessContext,
  type CorpusWorkspaceSnapshot,
  type FsPort,
  type ParsedFile,
} from "@agentproto/corpus"
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
import { buildCorpusIndex, hydrateHit, type CorpusIndex } from "./hydrate.js"

export interface CorpusAdapterCoreOptions {
  /** Filesystem rooted at the workspace side (cloud bucket, local fs, …). */
  readonly fs: FsPort
  /**
   * Workspace path within `fs`. The AIP-10 KNOWLEDGE.md lives at
   * `${workspacePath}/KNOWLEDGE.md`. Empty string means "fs is rooted
   * at the workspace".
   */
  readonly workspacePath: string
  /**
   * Backing IKnowledgeProvider — the files adapter or an external
   * vector store in production.
   * Receives the actual vector/graph query. The adapter wraps it for
   * provenance hydration + access policy.
   */
  readonly backing: IKnowledgeProvider
  /**
   * Optional time source. Defaults to `() => Date.now()`. Tests inject
   * a fixed clock for deterministic temporal scores.
   */
  readonly nowMs?: () => number
  /**
   * Optional snapshot cache strategy. By default the adapter re-scans
   * the workspace on every query — fine for small corpora, expensive
   * for big ones. Hosts can pass a memoized loader to amortize across
   * calls. The function is invoked once per `query()` call; cache TTL
   * is the implementer's call.
   */
  readonly loadSnapshot?: () => Promise<CorpusWorkspaceSnapshot>
  /**
   * Optional caller identity for access-policy enforcement.
   * When supplied, the adapter filters hits / source listings whose
   * `metadata.corpus.access` doesn't permit this caller. When omitted,
   * the adapter behaves as if the caller is fully trusted — useful
   * for admin paths + the indexer's internal writer.
   *
   * The host (Guilde corpus-host, corpus-cli) builds this per request
   * via `IdentityPort.resolve()`.
   */
  readonly caller?: AccessCaller
  /**
   * Workspace context the access policy needs alongside the caller —
   * notably `homeGuild`, which `classification: internal` checks
   * against the caller's identity tree. Hosts that bind a corpus
   * adapter to a specific guild (Guilde corpus-host) populate this;
   * standalone topologies (corpus-cli, tests) may leave it empty,
   * in which case `internal` fails closed.
   */
  readonly accessContext?: AccessContext
}

export const CORPUS_ENGINE_ID = "corpus" as const

/**
 * The adapter's reported capabilities are the backing engine's — the
 * corpus is a wrapper, not a vector store itself. citations is forced
 * to `true` because we always emit `entryPath` + `sourceIds` provenance.
 */
function makeCapabilities(
  backing: KnowledgeCapabilities
): KnowledgeCapabilities {
  return Object.freeze({
    ...backing,
    citations: true,
  })
}

export class CorpusAdapterCore implements IKnowledgeProvider {
  readonly id = CORPUS_ENGINE_ID
  readonly capabilities: KnowledgeCapabilities

  private readonly fs: FsPort
  private readonly workspacePath: string
  private readonly backing: IKnowledgeProvider
  private readonly nowMs: () => number
  private readonly loadSnapshotImpl: () => Promise<CorpusWorkspaceSnapshot>
  private readonly caller: AccessCaller | undefined
  private readonly accessContext: AccessContext

  constructor(opts: CorpusAdapterCoreOptions) {
    this.fs = opts.fs
    this.workspacePath = opts.workspacePath
    this.backing = opts.backing
    this.nowMs = opts.nowMs ?? (() => Date.now())
    this.capabilities = makeCapabilities(opts.backing.capabilities)
    this.caller = opts.caller
    this.accessContext = opts.accessContext ?? {}

    const reader = new CorpusWorkspaceReader({ fs: this.fs })
    this.loadSnapshotImpl =
      opts.loadSnapshot ?? (() => reader.read(this.workspacePath))
  }

  /**
   * Unwrap the underlying backing engine. The naming is intentionally
   * alarming: any caller that reaches the raw engine bypasses the
   * adapter's policy + hydration layer and can `ingest()` / `query()`
   * without the corpus's AIP-10 audit trail.
   *
   * The ONLY legitimate caller is the host's `corpus-host` service,
   * which feeds the engine into a `CorpusInternalWriter` so the
   * indexer can push chunks at promote time. Agent-side code MUST
   * NOT call this — agent tools receive `IKnowledgeProvider` and
   * never narrow to `CorpusAdapterCore`.
   */
  _unsafeUnwrapBackingEngine(): IKnowledgeProvider {
    return this.backing
  }

  /** Workspace path the adapter targets — handy for the host shim. */
  get workspacePathInternal(): string {
    return this.workspacePath
  }

  /**
   * Typed capability used by promote-candidate to access the wrapped
   * backing engine without `instanceof` checks at the call site. The
   * tool detects this via `isCorpusBackingUnwrap(provider)` — see
   * `./unwrap.ts` — so the engine identity check stays out of business
   * code (per `feedback_no_engineid_switches`).
   */
  unwrapCorpusBacking(): IKnowledgeProvider {
    return this.backing
  }

  get corpusWorkspacePath(): string {
    return this.workspacePath
  }

  // ── Public IKnowledgeProvider surface ─────────────────────────────

  async ingest(_input: KnowledgeIngestInput): Promise<KnowledgeSource> {
    throw new Error(
      "CorpusAdapterCore: ingest() is not permitted on a corpus engine. " +
        "Use the corpus lifecycle (corpus.create_candidate → analyze → " +
        "promote) which routes writes through the privileged " +
        "CorpusInternalWriter. Agent-side ingestion would bypass the " +
        "AIP-18 candidate review pipeline."
    )
  }

  async deleteSource(_id: string): Promise<void> {
    throw new Error(
      "CorpusAdapterCore: deleteSource() is not permitted on a corpus engine. " +
        "Use corpus admin tools (deprecation marks status: deprecated; " +
        "GDPR erasure goes through corpus.erase_personal_data which " +
        "preserves attestation hashes via content tombstoning)."
    )
  }

  async query(q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
    const snapshot = await this.loadSnapshotImpl()

    // Cold-start sentinel: loadSnapshot timed out and returned an empty
    // placeholder (workspace === null, no sources/entries). Skip the backing
    // query — it would also cold-build its index for nothing, adding another
    // 4 s timeout to the critical path.  Fire-and-forget to warm both the
    // snapshot (already warming in background) and the backing index so the
    // next turn is fast.
    if (
      snapshot.workspace === null &&
      snapshot.sources.length === 0 &&
      snapshot.entries.length === 0
    ) {
      void this.backing.query(q).catch(() => {})
      return { engine: this.id, modeUsed: "none" as const, hits: [], tookMs: 0 }
    }

    const index = buildCorpusIndex(snapshot)
    const result = await this.backing.query(q)
    const nowMs = this.nowMs()
    // Hydrate every hit + apply access policy filter. Filter is
    // silent — caller never learns about filtered hits, no
    // "you have N matching results but can't see them" leakage.
    const hits: KnowledgeHit[] = []
    for (const raw of result.hits) {
      const h = hydrateHit(raw, index, nowMs)
      if (!this.callerCanSeeEntry(h, index)) continue
      hits.push(h)
    }
    return {
      // Surface "corpus" as the engine id so call sites can identify
      // the wrapper. Backing engine id is in hit.metadata.engineId if
      // the backing adapter exposes it.
      engine: this.id,
      modeUsed: result.modeUsed,
      hits,
      tookMs: result.tookMs,
    }
  }

  /**
   * Check whether the caller (if any) can see this hit. When no
   * caller is supplied at construction time, the adapter behaves as
   * fully-trusted (admin path, indexer's internal writer). When a
   * caller IS supplied, every hit goes through `evaluateAccess`
   * against `metadata.corpus.access` on the canonical AIP-10 entry.
   *
   * Fail-closed when a caller is present: a hit without an entrySlug,
   * or one whose entry is missing from the workspace index, has no
   * verifiable access spec — we hide it rather than serve unverifiable
   * provenance. Avoids a window where an attacker who removed an
   * entry's file (or raced the lifecycle) could harvest stale chunks.
   */
  private callerCanSeeEntry(hit: KnowledgeHit, index: CorpusIndex): boolean {
    if (!this.caller) return true
    const meta = hit.metadata as { entrySlug?: unknown } | undefined
    if (typeof meta?.entrySlug !== "string") return false
    const entry = index.entryBySlug.get(meta.entrySlug)
    if (!entry) return false
    const spec = readAccessSpec(entry.frontmatter)
    const decision = evaluateAccess(spec, this.caller, this.accessContext)
    return decision.permitted
  }

  async listSources(
    filter?: ListSourcesFilter
  ): Promise<readonly KnowledgeSource[]> {
    // Sources come from the AIP-10 file system (sources/...), not the
    // backing engine. The backing engine's "sources" are chunks of
    // entries; the canonical sources are the .md files under sources/.
    const snapshot = await this.loadSnapshotImpl()
    const out: KnowledgeSource[] = []
    for (const file of snapshot.sources) {
      // Access filter — silently skip sources the caller can't see.
      // Same matrix as entries.
      if (!this.callerCanSeeFile(file)) continue
      const source = sourceFromParsedFile(file)
      if (filter?.kind && source.kind !== filter.kind) continue
      if (filter?.status && source.status !== filter.status) continue
      out.push(source)
    }
    return Object.freeze(out)
  }

  private callerCanSeeFile(file: ParsedFile): boolean {
    if (!this.caller) return true
    const spec = readAccessSpec(file.frontmatter)
    const decision = evaluateAccess(spec, this.caller, this.accessContext)
    return decision.permitted
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const snapshot = await this.loadSnapshotImpl()
    const file = snapshot.sources.find(s => s.frontmatter.id === id)
    if (!file) return null
    // Access filter — silent null when the caller can't see it.
    if (!this.callerCanSeeFile(file)) return null
    // Pin the returned id to the caller-supplied one — by-id lookups
    // round-trip the same id back even when the frontmatter omits it.
    return sourceFromParsedFile(file, id)
  }

  async healthCheck(): Promise<boolean> {
    // Corpus is healthy iff both the workspace is reachable and the
    // backing engine reports healthy. If the backing engine doesn't
    // implement healthCheck, assume healthy.
    try {
      const knowledgePath = this.workspacePath
        ? `${this.workspacePath}/KNOWLEDGE.md`
        : "KNOWLEDGE.md"
      const wsOk = await this.fs.exists(knowledgePath)
      if (!wsOk) return false
      if (typeof this.backing.healthCheck === "function") {
        return await this.backing.healthCheck()
      }
      return true
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    if (typeof this.backing.dispose === "function") {
      await this.backing.dispose()
    }
  }
}

/**
 * Build a `KnowledgeSource` from an AIP-10 source file. Shared by
 * `listSources` (no id override — read it off the frontmatter) and
 * `getSource` (id override — round-trip the caller-supplied id).
 */
function sourceFromParsedFile(
  file: ParsedFile,
  idOverride?: string
): KnowledgeSource {
  const fm = file.frontmatter
  const metaRecord =
    (fm.metadata as Record<string, unknown> | undefined) ?? undefined
  const bytesFromMeta =
    metaRecord && typeof metaRecord.bytes === "number"
      ? (metaRecord.bytes as number)
      : undefined
  return {
    id: idOverride ?? (typeof fm.id === "string" ? fm.id : file.path),
    kind: "file",
    uri: typeof fm.path === "string" ? fm.path : file.path,
    title: typeof fm.title === "string" ? fm.title : undefined,
    bytes: bytesFromMeta ?? file.body.length,
    status: "ready",
    indexedAt:
      typeof fm.captured_at === "string" ? new Date(fm.captured_at) : undefined,
    metadata: {
      contentHash: fm.content_hash,
      authority: fm.authority,
      language: fm.language,
      tags: fm.tags,
      ...(metaRecord ?? {}),
    },
  }
}
