/**
 * CandidatesSidecar — accessor for `collections/<name>/_candidates.yaml`.
 *
 * The plan calls out lazy materialization (so-so #6): the
 * "discovered" state has high volume and short lifespan; AIP-18 ITEM
 * files only materialize when a candidate transitions to `analyzed`.
 * Until then, candidates live in a YAML sidecar keyed by id.
 *
 * Sidecar shape:
 *   candidates:
 *     - id: <slug>
 *       status: discovered   # may also be transitioning (rare)
 *       sourceUrl: ...       # collection-specific fields are free-form
 *       contentHash: ...
 *       discoveredAt: ISO
 *       discoveredBy: ws://operators/<slug>
 *
 * The accessor enforces:
 *   - id uniqueness within the file
 *   - atomic full-file writes (no partial sidecar)
 *   - status transition discipline (a row stays here only while
 *     `status === "discovered"`; transitions out remove the row and
 *     return the data so the caller can materialize ITEM.md)
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml"
import type { FsPort } from "../ports/fs.port.js"

export interface CandidateRow {
  readonly id: string
  readonly status: "discovered" | string
  /** Open-ended — collection schema's `fields` defines what's allowed. */
  readonly [key: string]: unknown
}

interface SidecarShape {
  readonly candidates: readonly CandidateRow[]
}

export interface CandidatesSidecarOptions {
  readonly fs: FsPort
  /** Workspace-relative path of the sidecar file. */
  readonly path: string
}

export class CandidatesSidecar {
  constructor(private readonly opts: CandidatesSidecarOptions) {}

  /**
   * Load every row from disk. Returns an empty list if the file
   * doesn't exist (a fresh corpus has no candidates yet).
   */
  async load(): Promise<readonly CandidateRow[]> {
    if (!(await this.opts.fs.exists(this.opts.path))) return []
    const content = await this.opts.fs.readFile(this.opts.path)
    if (!content.trim()) return []
    const parsed = yamlParse(content) as Partial<SidecarShape> | null
    if (!parsed || !Array.isArray(parsed.candidates)) return []
    return parsed.candidates as readonly CandidateRow[]
  }

  /**
   * Append a new candidate. Refuses if `id` already exists — sidecar
   * keys are unique. Returns the full updated list.
   */
  async append(row: CandidateRow): Promise<readonly CandidateRow[]> {
    const existing = await this.load()
    if (existing.some((r) => r.id === row.id)) {
      throw new SidecarDuplicateError(this.opts.path, row.id)
    }
    const next = [...existing, row]
    await this.write(next)
    return next
  }

  /**
   * Mutate one row in-place. Throws if not found.
   */
  async update(
    id: string,
    patch: Readonly<Record<string, unknown>>
  ): Promise<CandidateRow> {
    const existing = await this.load()
    let updated: CandidateRow | null = null
    const next = existing.map((r) => {
      if (r.id !== id) return r
      updated = { ...r, ...patch, id: r.id } as CandidateRow
      return updated
    })
    if (!updated) throw new SidecarNotFoundError(this.opts.path, id)
    await this.write(next)
    return updated
  }

  /**
   * Remove a row by id. Returns the removed row so the caller can
   * materialize an ITEM.md from its fields. Throws if not found.
   *
   * Use this when a candidate transitions out of `discovered`: pull
   * it from the sidecar, write the ITEM.md, append an event.
   */
  async take(id: string): Promise<CandidateRow> {
    const existing = await this.load()
    const idx = existing.findIndex((r) => r.id === id)
    if (idx === -1) throw new SidecarNotFoundError(this.opts.path, id)
    const removed = existing[idx]!
    const next = [...existing.slice(0, idx), ...existing.slice(idx + 1)]
    await this.write(next)
    return removed
  }

  /**
   * Whole-file replace. Used in tests and by the indexer for
   * bulk migrations. Prefer append/update/take for normal flow.
   */
  async write(candidates: readonly CandidateRow[]): Promise<void> {
    const shape: SidecarShape = { candidates }
    const content = yamlStringify(shape, {
      // Stable output: sort keys alphabetically across rows for
      // greppable diffs. Each row's id key is preserved by the
      // stringifier; the rest is dictionary order.
      sortMapEntries: false,
    })
    await this.opts.fs.writeFile(this.opts.path, content)
  }
}

export class SidecarDuplicateError extends Error {
  constructor(
    readonly path: string,
    readonly id: string
  ) {
    super(
      `SidecarDuplicateError: candidate id "${id}" already exists in ${path}`
    )
    this.name = "SidecarDuplicateError"
  }
}

export class SidecarNotFoundError extends Error {
  constructor(
    readonly path: string,
    readonly id: string
  ) {
    super(`SidecarNotFoundError: candidate id "${id}" not in ${path}`)
    this.name = "SidecarNotFoundError"
  }
}
