/**
 * Playbook surface types — shared by registry, resolver, lifecycle.
 *
 * AIP-12 PLAYBOOK frontmatter is rich (targets, kind, lock_check,
 * evidence, status, supersedes, history, …). The registry parses
 * the full shape; the public types here cover the fields the
 * resolver and the lifecycle need.
 *
 * Corpus-specific extension fields (shadowTrafficPct, autoPromote,
 * shadowMetrics, archiveReason, execution) live under
 * `metadata.corpus.*` until the AIP-12 spec hoists them to first-class
 * fields; we surface them as a typed namespace on the parsed playbook
 * so callers don't dig into untyped frontmatter.
 */

import type { ParsedFile } from "../types.js"

export type PlaybookStatus = "shadow" | "active" | "archived"

export type PlaybookKind = "overlay" | "block-replacement"

export type PlaybookTargetKind = "operator" | "role" | "skill" | "runtime"

export interface PlaybookTarget {
  readonly kind: PlaybookTargetKind
  readonly ref: string
}

export interface PlaybookCorpusMeta {
  /** 0..1 — fraction of traffic this shadow plays on. */
  readonly shadowTrafficPct?: number
  /** Records the win-rate vs baseline + sample size. */
  readonly shadowMetrics?: {
    readonly sampleSize?: number
    readonly winRateVsBaseline?: number | null
    readonly lastEvaluatedAt?: string | null
  }
  readonly autoPromote?: {
    readonly enabled: boolean
    readonly metric: string
    readonly threshold: { gte?: number; lte?: number }
    readonly minSampleSize: number
    readonly cooldown?: string
  }
  readonly archiveReason?: string | null
  readonly execution?: "sandboxed" | "inProcess"
  readonly authoredBy?: string
  readonly derivedFromGap?: string
  /** Free-form forward-compat. */
  readonly [key: string]: unknown
}

export interface Playbook {
  /** Workspace-relative path of the .md file. */
  readonly path: string
  readonly slug: string
  readonly title: string
  readonly status: PlaybookStatus
  readonly kind: PlaybookKind
  /** Priority for overlay ordering — higher first. Default 100. */
  readonly priority: number
  readonly targets: readonly PlaybookTarget[]
  /** Optional convenience — narrower than targets[]. */
  readonly bindsOperator?: string
  readonly supersedes: readonly string[]
  /** Markdown body — the overlay text. */
  readonly body: string
  /** Corpus-namespaced extension fields (metadata.corpus.*). */
  readonly corpus: PlaybookCorpusMeta
  /** Hash of file content for optimistic-concurrency CAS writes. */
  readonly versionToken: string
  /** The raw parsed file — exposed for the lifecycle CAS path. */
  readonly file: ParsedFile
}

/** Selector for `listBy` queries. */
export interface PlaybookQuery {
  readonly status?: PlaybookStatus | readonly PlaybookStatus[]
  readonly operatorRef?: string
  /** Match on `kind` (overlay | block-replacement). */
  readonly kind?: PlaybookKind
  /** Match playbooks bound to this slug (binds_operator OR targets[]). */
  readonly forOperatorSlug?: string
}
