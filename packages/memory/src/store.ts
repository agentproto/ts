import type { MemoryDocument, MemoryStatus, MemoryType } from "./types.js"

/**
 * AIP-72 section 8: the memory store port.
 *
 * The shapes below are the ones section 8 fixes, name for name. A store
 * keys items by `id`; `slug`, when present, is a second handle that is
 * unique among active items (rule 14). Writes are compare-and-set on the
 * opaque `revision` (rule 17), and nothing is ever hard deleted (rule 16).
 */

/** One stored item, or one pending proposal. */
export interface MemoryRecord {
  item: MemoryDocument
  /** Opaque; changes on every byte change of the stored document. */
  revision: string
  /** Set on a proposal, absent on an item. */
  proposalId?: string
}

export interface MemoryFilter {
  type?: MemoryType | readonly MemoryType[]
  status?: MemoryStatus | readonly MemoryStatus[]
  /** Matches at most one active item (rule 14, rule 20 overlap). */
  slug?: string
  /** Match any, e.g. `["global", "project:acme"]`. */
  tags?: readonly string[]
  /** Rules 10 and 11, at the store's clock. */
  inForce?: boolean
  /** List proposals instead of items. */
  proposals?: boolean
}

export interface MemorySearchHit {
  source: "memory" | "knowledge"
  /** REQUIRED when `source` is `"memory"`. */
  id?: string
  slug?: string
  title: string
  snippet?: string
  score?: number
  /** Provider pointer when `source` is `"knowledge"`. */
  ref?: string
}

export interface MemoryWriteOptions {
  mode: "propose" | "commit"
  /** The revision the caller last read (rule 17). */
  ifRevision?: string
  /** The proposal this commit promotes; dropped once the item is written (rule 21). */
  fromProposal?: string
}

export interface MemorySearchOptions {
  filter?: MemoryFilter
  limit?: number
}

export interface MemoryStore {
  write(item: MemoryDocument, opts: MemoryWriteOptions): Promise<MemoryRecord>
  read(id: string): Promise<MemoryRecord | null>
  list(filter?: MemoryFilter): Promise<readonly MemoryRecord[]>
  search(query: string, opts?: MemorySearchOptions): Promise<readonly MemorySearchHit[]>
  supersede(
    oldId: string,
    next: MemoryDocument,
    opts?: { ifRevision?: string },
  ): Promise<{ old: MemoryRecord; next: MemoryRecord }>
  archive(id: string, opts?: { ifRevision?: string }): Promise<MemoryRecord>
  dismiss(proposalId: string): Promise<void>
}

/** The section 8 port under the `I*` name its knowledge sibling uses. */
export type IMemoryStore = MemoryStore

export type MemoryStoreErrorCode =
  | "conflict"
  | "not-found"
  | "invalid-transition"
  | "slug-taken"

/**
 * Base of the store's typed failures. An invalid document is rejected
 * with the document package's `MemoryValidationError` instead, which
 * names the field (rule 13).
 */
export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode

  constructor(code: MemoryStoreErrorCode, message: string) {
    super(`memory store (AIP-72): ${message}`)
    this.name = "MemoryStoreError"
    this.code = code
  }
}

/** Rule 17: `ifRevision` missing or stale on a write that needs it. */
export class MemoryConflictError extends MemoryStoreError {
  readonly id: string
  /** The revision the caller sent, if any. */
  readonly expected: string | undefined
  /** The revision on disk, `undefined` when the item does not exist. */
  readonly actual: string | undefined

  constructor(id: string, expected: string | undefined, actual: string | undefined) {
    super(
      "conflict",
      expected === undefined
        ? `'${id}' exists: a write that changes it must carry ifRevision`
        : actual === undefined
          ? `'${id}' does not exist, but ifRevision '${expected}' was given`
          : `'${id}' is at revision '${actual}', not '${expected}'`,
    )
    this.name = "MemoryConflictError"
    this.id = id
    this.expected = expected
    this.actual = actual
  }
}

/** No item (or proposal) with that id. */
export class MemoryNotFoundError extends MemoryStoreError {
  readonly id: string
  readonly what: "item" | "proposal"

  constructor(what: "item" | "proposal", id: string) {
    super("not-found", `no ${what} '${id}'`)
    this.name = "MemoryNotFoundError"
    this.id = id
    this.what = what
  }
}

/** Rules 7 and 15: a status move the store does not allow. */
export class MemoryTransitionError extends MemoryStoreError {
  readonly id: string
  readonly from: MemoryStatus
  readonly to: MemoryStatus

  constructor(id: string, from: MemoryStatus, to: MemoryStatus, detail?: string) {
    super(
      "invalid-transition",
      `'${id}' cannot move from '${from}' to '${to}'${detail ? `: ${detail}` : ""}`,
    )
    this.name = "MemoryTransitionError"
    this.id = id
    this.from = from
    this.to = to
  }
}

/** Rule 14: another active item already holds the slug. */
export class MemorySlugTakenError extends MemoryStoreError {
  readonly slug: string
  /** The active item holding it. */
  readonly holder: string

  constructor(slug: string, holder: string) {
    super("slug-taken", `slug '${slug}' is held by active item '${holder}'`)
    this.name = "MemorySlugTakenError"
    this.slug = slug
    this.holder = holder
  }
}
