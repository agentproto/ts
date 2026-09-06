/**
 * `FederatedKnowledgeProvider` — fan-out query + merge over several
 * {@link IKnowledgeProvider} backends.
 *
 * The brain's single visible provider when a workspace configures multiple
 * knowledge backends: `query()` asks every consulted provider and fuses the
 * hits (per-provider min-max normalization × weight, no dedupe), `ingest()`
 * fans out to the `auto` providers, and the read/admin verbs union across
 * all of them. Failures degrade gracefully per provider — one sick backend
 * never takes the brain down.
 *
 * Deliberate single-provider passthrough: when exactly one provider is
 * queried, its result is returned UNCHANGED (its raw scores, its own
 * `engine`, its own `modeUsed`). That preserves today's exact behavior for
 * the default single `files` provider.
 */

import type {
  IKnowledgeProvider,
  KnowledgeCapabilities,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryMode,
  KnowledgeQueryResult,
  KnowledgeSource,
  ListSourcesFilter,
} from "@agentproto/knowledge-engine"
import type { ResolvedProvider } from "./provider-resolver.js"

export interface FederatedProvidersOptions {
  /** Resolved providers below this federation. */
  readonly providers: readonly ResolvedProvider[]
  /** Provider ids consulted by `query()`. Absent → all providers. */
  readonly defaultQueryProviders?: readonly string[]
}

interface ScoredHit {
  readonly hit: KnowledgeHit
  readonly order: number
  readonly score: number
  readonly modeUsed: KnowledgeQueryMode
}

/** Merge each sub-provider's capabilities: boolean caps are OR, the chunk
 *  ceiling is the strictest (min) of them. */
function mergeCapabilities(
  providers: readonly ResolvedProvider[],
): KnowledgeCapabilities {
  const caps = providers.map(p => p.provider.capabilities)
  return Object.freeze({
    vectorSearch: caps.some(c => c.vectorSearch),
    graphTraversal: caps.some(c => c.graphTraversal),
    hybridSearch: caps.some(c => c.hybridSearch),
    multiModal: caps.some(c => c.multiModal),
    streaming: caps.some(c => c.streaming),
    citations: caps.some(c => c.citations),
    maxChunkBytes:
      caps.length > 0 ? Math.min(...caps.map(c => c.maxChunkBytes)) : 0,
  })
}

export class FederatedKnowledgeProvider implements IKnowledgeProvider {
  readonly id = "federated"
  readonly capabilities: KnowledgeCapabilities

  private readonly providers: readonly ResolvedProvider[]
  private readonly defaultQueryProviders?: readonly string[]

  constructor(opts: FederatedProvidersOptions) {
    this.providers = opts.providers
    this.defaultQueryProviders = opts.defaultQueryProviders
    this.capabilities = mergeCapabilities(this.providers)
  }

  /** The subset of providers consulted on query: `defaultQueryProviders`
   *  intersected with the actual provider ids (absent → all). */
  private queryTargets(): ResolvedProvider[] {
    if (!this.defaultQueryProviders || this.defaultQueryProviders.length === 0) {
      return [...this.providers]
    }
    const wanted = new Set(this.defaultQueryProviders)
    return this.providers.filter(p => wanted.has(p.id))
  }

  async query(q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
    const targets = this.queryTargets()
    const settled = await Promise.allSettled(
      targets.map(async (p) => ({ p, result: await p.provider.query(q) })),
    )
    const fulfilled = settled.flatMap(r =>
      r.status === "fulfilled" ? [r.value] : [],
    )

    // Single queried provider → pass its result through UNCHANGED. This is
    // the guarantee that keeps today's default single-provider behavior
    // byte-for-byte identical (raw scores, its own `engine` / `modeUsed`).
    if (targets.length === 1 && fulfilled.length === 1) {
      return fulfilled[0]!.result
    }
    if (fulfilled.length === 0) {
      return { hits: [], tookMs: 0, engine: this.id, modeUsed: "none" }
    }

    const scored: ScoredHit[] = []
    let tookMs = 0
    let order = 0
    for (const { p, result } of fulfilled) {
      tookMs += result.tookMs
      const scores = result.hits.map(h => h.score)
      const max = scores.length > 0 ? Math.max(...scores) : Number.NaN
      const min = scores.length > 0 ? Math.min(...scores) : Number.NaN
      for (const hit of result.hits) {
        // Degenerate min-max (single hit / all equal scores) → treat the
        // provider's sole hit as a full-strength 1.0.
        const norm =
          scores.length === 0 || max === min ? 1.0 : (hit.score - min) / (max - min)
        scored.push({
          hit,
          order: order++,
          score: norm * p.weight,
          modeUsed: result.modeUsed,
        })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order)

    const topK = q.topK ?? 10
    const hits = scored.slice(0, topK).map(s => s.hit)
    // `modeUsed`: the mode of the result that contributed the highest-ranked
    // hit — "none" when there were no hits at all.
    const modeUsed =
      hits.length > 0 && scored[0] ? (scored[0]!.modeUsed as KnowledgeQueryMode) : "none"

    return { hits, tookMs, engine: this.id, modeUsed }
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
    const auto = this.providers.filter(p => p.auto)
    if (auto.length === 0) {
      throw new Error(
        "federated provider: no auto providers — nothing to ingest into",
      )
    }
    const settled = await Promise.allSettled(auto.map(p => p.provider.ingest(input)))
    const firstFulfilled = settled.find(r => r.status === "fulfilled")
    if (firstFulfilled) return firstFulfilled.value
    const firstRejected = settled.find(r => r.status === "rejected")
    if (firstRejected?.reason instanceof Error) throw firstRejected.reason
    throw new Error("federated provider: all auto providers failed to ingest")
  }

  async listSources(
    filter?: ListSourcesFilter,
  ): Promise<readonly KnowledgeSource[]> {
    const settled = await Promise.allSettled(
      this.providers.map(p => p.provider.listSources(filter)),
    )
    const out: KnowledgeSource[] = []
    for (const r of settled) {
      if (r.status === "fulfilled") out.push(...r.value)
    }
    return out
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const settled = await Promise.allSettled(
      this.providers.map(p => p.provider.getSource(id)),
    )
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) return r.value
    }
    return null
  }

  async deleteSource(id: string): Promise<void> {
    const settled = await Promise.allSettled(
      this.providers.map(p => p.provider.deleteSource(id)),
    )
    const rejected = settled.filter(r => r.status === "rejected")
    if (rejected.length === settled.length && settled.length > 0) {
      if (rejected[0]?.reason instanceof Error) throw rejected[0].reason
      throw new Error("federated provider: all providers failed to delete the source")
    }
  }

  async healthCheck(): Promise<boolean> {
    const settled = await Promise.allSettled(
      this.providers.map(p => p.provider.healthCheck()),
    )
    return settled.some(r => r.status === "fulfilled" && r.value === true)
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.providers.map(p => p.provider.dispose()))
  }
}
