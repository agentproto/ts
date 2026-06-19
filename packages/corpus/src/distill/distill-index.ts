/**
 * DistillIndex — the persistent ledger of "what was distilled, when, by which
 * engine" for one corpus. A sidecar YAML at `_distill-index.yaml` under the
 * corpus root, keyed by the raw source's provenance id (the same id that lands
 * in each refined entry's `sources:` backlink).
 *
 * Why a ledger when `scanDistilledSourceIds` already derives "done" from the
 * entries themselves? Because the entry scan answers only a boolean ("has this
 * source any entry?") and loses the *cadence*: when it ran, with which engine,
 * how many entries it produced, the source's content hash at the time. The
 * ledger records that, so:
 *   - a run can skip by content hash (re-distill only when the source changed),
 *   - the corpus carries an auditable, git-diffable distillation history,
 *   - cost/coverage is queryable without re-reading every entry.
 *
 * Same shape + discipline as {@link CandidatesSidecar}: whole-file atomic
 * writes via FsPort, empty list for a fresh corpus, upsert (not append-only)
 * keyed by `sourceId` because a source legitimately re-distills.
 *
 * Pure: consumes FsPort only, no node:fs / no clock (the caller stamps the time).
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml"
import type { FsPort } from "../ports/fs.port.js"

/** Default corpus-relative location of the ledger. */
export const DISTILL_INDEX_PATH = "_distill-index.yaml" as const

/** One distillation record — keyed by `(sourceId, lensId)`. */
export interface DistillIndexRecord {
  /** Raw source provenance id (matches the entries' `sources:` backlink). */
  readonly sourceId: string
  /**
   * Lens id this run distilled under, when a lens was applied. Part of the key:
   * the same source distilled under "diary" and "marketing" is two rows with
   * independent cadence. Absent (undefined) = the generic, lens-less pass.
   */
  readonly lensId?: string
  /** Human title of the source at distill time (for greppable diffs). */
  readonly title?: string
  /** ISO-8601 instant the distillation ran. */
  readonly distilledAt: string
  /** Engine label that produced the entries (e.g. "claude-code", "anthropic-api"). */
  readonly engine?: string
  /** Source content hash at distill time — lets a re-run skip unchanged sources. */
  readonly contentHash?: string
  /** How many refined entries this run wrote. */
  readonly entryCount: number
  /** Workspace-relative paths of the entries written this run. */
  readonly entryPaths?: readonly string[]
}

interface IndexShape {
  readonly runs: readonly DistillIndexRecord[]
}

export interface DistillIndexOptions {
  readonly fs: FsPort
  /** Workspace-relative path of the ledger. Defaults to {@link DISTILL_INDEX_PATH}. */
  readonly path?: string
}

export class DistillIndex {
  private readonly fs: FsPort
  private readonly path: string

  constructor(opts: DistillIndexOptions) {
    this.fs = opts.fs
    this.path = opts.path ?? DISTILL_INDEX_PATH
  }

  /** Every record on disk. Empty for a fresh corpus (no file yet). */
  async load(): Promise<readonly DistillIndexRecord[]> {
    if (!(await this.fs.exists(this.path))) return []
    const content = await this.fs.readFile(this.path)
    if (!content.trim()) return []
    const parsed = yamlParse(content) as Partial<IndexShape> | null
    if (!parsed || !Array.isArray(parsed.runs)) return []
    return parsed.runs as readonly DistillIndexRecord[]
  }

  /**
   * The record for a `(sourceId, lensId)` pair, or null if never distilled.
   * `lensId` undefined matches the generic lens-less row (back-compat).
   */
  async get(
    sourceId: string,
    lensId?: string
  ): Promise<DistillIndexRecord | null> {
    const rows = await this.load()
    return rows.find(r => r.sourceId === sourceId && r.lensId === lensId) ?? null
  }

  /**
   * True if the `(source, lens)` pair was distilled with a matching content
   * hash (when given). Each lens has independent cadence over the same source.
   */
  async isDistilled(
    sourceId: string,
    contentHash?: string,
    lensId?: string
  ): Promise<boolean> {
    const row = await this.get(sourceId, lensId)
    if (!row) return false
    if (contentHash === undefined) return true
    return row.contentHash === contentHash
  }

  /**
   * Upsert a record by `(sourceId, lensId)`. Re-distilling overwrites that
   * pair's row (cadence is "latest run wins") while leaving the same source's
   * other lens rows untouched; a new pair appends. Returns the full list.
   */
  async record(row: DistillIndexRecord): Promise<readonly DistillIndexRecord[]> {
    const existing = await this.load()
    const idx = existing.findIndex(
      r => r.sourceId === row.sourceId && r.lensId === row.lensId
    )
    const next =
      idx === -1
        ? [...existing, row]
        : [...existing.slice(0, idx), row, ...existing.slice(idx + 1)]
    await this.write(next)
    return next
  }

  /** Whole-file replace. Prefer {@link record} for normal flow. */
  async write(runs: readonly DistillIndexRecord[]): Promise<void> {
    const shape: IndexShape = { runs }
    await this.fs.writeFile(this.path, yamlStringify(shape))
  }
}
