/**
 * Typed accessors for the `metadata.corpus.*` block on AIP-10 entries
 * and KNOWLEDGE.md workspace manifests.
 *
 * Replaces the pervasive
 *   `(fm.metadata as { corpus?: ... }).corpus`
 * ladder previously open-coded in hydrate.ts + adapter.ts + the
 * internal writer. Narrowing once at the boundary keeps the rest of
 * the code working against a typed shape.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/corpus/frontmatter.ts`) —
 * this file has zero external imports, so it re-homes as-is.
 */

/**
 * Shape of `metadata.corpus.*` we care about. Mirrors the v1 plan —
 * extend here when the spec grows; consumers either narrow further or
 * fall back to `Record<string, unknown>` via the `extra` escape hatch.
 */
export interface CorpusFrontmatter {
  status?: string
  qualityScore?: number
  riskScore?: number
  domain?: string
  channel?: string
  funnelStage?: string
  entrySlug?: string
  temporal?: CorpusTemporal
  /** Workspace-scoped overrides from KNOWLEDGE.md. */
  defaultHalfLifeDays?: number
  /** Resolved provenance (id + url + title) written at promote time. */
  source_refs?: ReadonlyArray<CorpusSourceRef>
}

export interface CorpusSourceRef {
  id: string
  url?: string
  title?: string
  authority?: string
  language?: string
}

export interface CorpusTemporal {
  /** Per-entry half-life override (decay applied to mention scores). */
  halfLifeDays?: number
  /** Workspace-level default half-life from KNOWLEDGE.md. */
  defaultHalfLifeDays?: number
  lastSeen?: string
  mentions?: ReadonlyArray<{ at?: string; weight?: number }>
  // Legal validity window — DISTINCT from halfLife (marketing-style
  // relevance decay). These describe when the underlying norm is
  // legally in force, not how fresh the entry is.
  /** ISO date the norm enters into force. */
  inForceFrom?: string
  /** ISO date the norm ceases to be in force. */
  inForceTo?: string
  /** True when the norm has been abrogated / repealed. */
  abrogated?: boolean
  /** ISO date of the consolidated version this entry was taken from. */
  versionedAt?: string
}

/**
 * Read `metadata.corpus` off a frontmatter object (AIP-10 entries +
 * KNOWLEDGE.md workspace manifests). Returns `{}` when the block is
 * missing so call sites can use `?.field` without the outer
 * `if (corpus)` guard.
 */
export function readCorpusFrontmatter(
  frontmatter: Readonly<Record<string, unknown>> | undefined
): CorpusFrontmatter {
  const meta = frontmatter?.metadata
  if (!meta || typeof meta !== "object") return {}
  return readCorpusBlock(meta as Readonly<Record<string, unknown>>)
}

/**
 * Read `corpus.*` directly off a flat record — used when callers
 * already hold the `metadata` block (e.g. KnowledgeHit.metadata,
 * KnowledgeSource.metadata) without the outer frontmatter wrapper.
 */
export function readCorpusBlock(
  record: Readonly<Record<string, unknown>> | undefined
): CorpusFrontmatter {
  const corpus = record?.corpus
  if (!corpus || typeof corpus !== "object") return {}
  return corpus as CorpusFrontmatter
}

/**
 * Read `metadata.corpus.temporal` directly — convenience for hot
 * paths that only need this nested slice.
 */
export function readCorpusTemporal(
  frontmatter: Readonly<Record<string, unknown>> | undefined
): CorpusTemporal | undefined {
  return readCorpusFrontmatter(frontmatter).temporal
}
