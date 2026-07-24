/**
 * Hydration helpers — turn a backing-engine hit + corpus workspace
 * snapshot into a corpus-grade `KnowledgeHit` with full AIP-10
 * provenance.
 *
 * The corpus adapter's contract is: every hit returned to the LLM
 * carries `entryPath`, `sourceIds`, `sourceHashes`, `kind`, `status`,
 * `qualityScore`, `riskScore`, `domain`, `channel`, and the temporal
 * block (lastSeen, mentionCount, temporalScore). The backing engine
 * holds the chunk text + vector; the AIP-10 entry file holds the
 * provenance metadata. Hydration is the join.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/corpus/hydrate.ts`) — the
 * only change is the `KnowledgeHit` import path: it now comes from
 * `@agentproto/knowledge-engine` (was `../../types/knowledge.types`).
 */

import type { CorpusWorkspaceSnapshot, ParsedFile } from "@agentproto/corpus"
import type { KnowledgeHit } from "@agentproto/knowledge-engine"
import {
  readCorpusBlock,
  readCorpusFrontmatter,
  readCorpusTemporal,
} from "./frontmatter.js"

/**
 * Build a fast lookup index from a workspace snapshot. The adapter
 * calls this once per query (or caches it across queries — caller's
 * call). Lookups by entry slug + source id are O(1).
 */
export interface CorpusIndex {
  readonly entryBySlug: ReadonlyMap<string, ParsedFile>
  readonly entryByPath: ReadonlyMap<string, ParsedFile>
  readonly sourceById: ReadonlyMap<string, ParsedFile>
  readonly halfLifeDays: number
}

const DEFAULT_HALF_LIFE_DAYS = 180

export function buildCorpusIndex(
  snapshot: CorpusWorkspaceSnapshot
): CorpusIndex {
  const entryBySlug = new Map<string, ParsedFile>()
  const entryByPath = new Map<string, ParsedFile>()
  for (const entry of snapshot.entries) {
    const slug = entry.frontmatter.slug
    if (typeof slug === "string") entryBySlug.set(slug, entry)
    entryByPath.set(entry.path, entry)
  }

  const sourceById = new Map<string, ParsedFile>()
  for (const source of snapshot.sources) {
    const id = source.frontmatter.id
    if (typeof id === "string") sourceById.set(id, source)
  }

  const halfLifeDays =
    extractWorkspaceHalfLife(snapshot) ?? DEFAULT_HALF_LIFE_DAYS

  return Object.freeze({
    entryBySlug,
    entryByPath,
    sourceById,
    halfLifeDays,
  })
}

/**
 * Compute the corpus temporal score for an entry:
 *
 *   max over mentions[m] of m.weight × exp(-ln2 × ageDays(m.at) / halfLife)
 *
 * Returns 1.0 if no mentions block is present (fallback to
 * updated_at). 0.0 if updated_at is also missing. Bounded [0, 1].
 */
export function computeTemporalScore(
  entry: ParsedFile,
  nowMs: number,
  defaultHalfLifeDays: number
): { temporalScore: number; lastSeen: string | null; mentionCount: number } {
  const temporal = readCorpusTemporal(entry.frontmatter)
  const halfLife = temporal?.halfLifeDays ?? defaultHalfLifeDays
  const mentions = temporal?.mentions ?? []

  if (mentions.length === 0) {
    // Fallback to updated_at — every active entry has it per AIP-10
    const updatedAt = entry.frontmatter.updated_at
    if (typeof updatedAt !== "string") {
      return { temporalScore: 0, lastSeen: null, mentionCount: 0 }
    }
    return {
      temporalScore: decay(Date.parse(updatedAt), nowMs, halfLife),
      lastSeen: updatedAt,
      mentionCount: 0,
    }
  }

  let best = 0
  let lastSeen: string | null = null
  let lastSeenMs = 0
  for (const m of mentions) {
    if (typeof m.at !== "string") continue
    const at = Date.parse(m.at)
    if (Number.isNaN(at)) continue
    const w = typeof m.weight === "number" ? m.weight : 1
    const s = w * decay(at, nowMs, halfLife)
    if (s > best) best = s
    if (at > lastSeenMs) {
      lastSeenMs = at
      lastSeen = m.at
    }
  }
  return {
    temporalScore: Math.max(0, Math.min(1, best)),
    lastSeen: lastSeen ?? temporal?.lastSeen ?? null,
    mentionCount: mentions.length,
  }
}

function decay(atMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - atMs) / 86_400_000)
  return Math.exp(-(Math.LN2 * ageDays) / halfLifeDays)
}

function extractWorkspaceHalfLife(
  snapshot: CorpusWorkspaceSnapshot
): number | undefined {
  return readCorpusTemporal(snapshot.workspace?.frontmatter)
    ?.defaultHalfLifeDays
}

/**
 * Hydrate a backing-engine hit with corpus provenance from the
 * workspace snapshot.
 *
 * Resolution path:
 *   1. The backing engine MUST carry `metadata.corpus.entrySlug` on
 *      the hit (the indexer writes it on push). If absent, the hit
 *      passes through unhydrated — the caller likely queried a
 *      non-corpus-managed source.
 *   2. Look up the entry by slug in the index.
 *   3. Resolve source ids → source hashes via the source index.
 *   4. Compute the live temporal score (now-anchored).
 *   5. Merge: backing-engine metadata + canonical AIP-10 provenance,
 *      with canonical fields winning on collision.
 */
export function hydrateHit(
  hit: KnowledgeHit,
  index: CorpusIndex,
  nowMs: number
): KnowledgeHit {
  // hit.metadata is the flat metadata block (not wrapped in a
  // frontmatter), so use readCorpusBlock rather than readCorpusFrontmatter.
  const slug = readCorpusBlock(hit.metadata).entrySlug
  if (typeof slug !== "string") return hit

  const entry = index.entryBySlug.get(slug)
  if (!entry) return hit

  const fm = entry.frontmatter
  const corpus = readCorpusFrontmatter(fm)

  // Resolve source ids → hashes for citation
  const sourceIds = Array.isArray(fm.sources)
    ? fm.sources.filter((s): s is string => typeof s === "string")
    : []
  const sourceHashes: string[] = []
  for (const sid of sourceIds) {
    const source = index.sourceById.get(sid)
    const hash = source?.frontmatter.content_hash
    if (typeof hash === "string") sourceHashes.push(hash)
  }

  const temporal = computeTemporalScore(entry, nowMs, index.halfLifeDays)

  const hydratedMetadata: Record<string, unknown> = {
    ...hit.metadata,
    entryPath: entry.path,
    entrySlug: slug,
    sourceIds,
    sourceHashes,
    // Resolved origins (id + url + title) so the agent can cite the source.
    ...(corpus.source_refs ? { sourceRefs: corpus.source_refs } : {}),
    kind: fm.kind,
    title: fm.title,
    tags: fm.tags ?? [],
    confidence: fm.confidence,
    // Corpus provenance (last so it wins on collision with backing).
    status: corpus.status,
    qualityScore: corpus.qualityScore,
    riskScore: corpus.riskScore,
    domain: corpus.domain,
    channel: corpus.channel,
    funnelStage: corpus.funnelStage,
    temporal: {
      lastSeen: temporal.lastSeen,
      mentionCount: temporal.mentionCount,
      temporalScore: temporal.temporalScore,
    },
  }

  return {
    ...hit,
    metadata: hydratedMetadata,
  }
}
