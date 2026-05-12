/**
 * agentcatalog/v1 — public types.
 *
 * A Catalog<T> is built from N CatalogSources. Each source declares a
 * tier. When multiple sources return the same item (identified by a
 * keyBy selector), the highest-priority tier wins and duplicates are
 * surfaced as `alternateSources` rather than silently dropped.
 */

/**
 * Priority order: earlier tiers beat later tiers during dedup.
 * "builtin" always wins; "collection" (curated picks) is last.
 */
export type CatalogSourceTier =
  | "builtin"
  | "curated"
  | "marketplace"
  | "private"
  | "collection"

export const DEFAULT_TIER_PRIORITY: readonly CatalogSourceTier[] = [
  "builtin",
  "curated",
  "marketplace",
  "private",
  "collection",
] as const

export interface CatalogOptions<T> {
  /**
   * Informational label used in error messages. Common values:
   * `"skills"`, `"operators"`, `"integrations"`, `"runtimes"`.
   */
  family: string
  /**
   * Derive a stable identity key from an item. Used for dedup across
   * sources. Defaults to inspecting `item.id`, `item.slug`, or
   * `item.name` (first truthy value).
   */
  keyBy?: (item: T) => string
  /**
   * Tier priority order. Earlier = higher priority. Defaults to
   * `DEFAULT_TIER_PRIORITY`. Override to put private items first, etc.
   */
  tierPriority?: readonly CatalogSourceTier[]
}

/** A single source that contributes items to a Catalog<T>. */
export interface CatalogSource<T> {
  /** Unique id within the catalog. */
  readonly id: string
  /** Human-readable display name. */
  readonly label: string
  /** Tier affects dedup priority and can drive UI grouping. */
  readonly tier: CatalogSourceTier
  /** Fetch all items from this source. May throw. */
  fetch(): Promise<T[]>
}

/** An item as it appears in the merged result, with provenance. */
export interface CatalogEntry<T> {
  item: T
  /** Id of the source that "won" (highest-priority tier). */
  sourceId: string
  /** Ids of other sources that also had this item (dedup losers). */
  alternateSources: string[]
}

export interface CatalogResult<T> {
  /** Deduplicated item list, primary source wins. */
  items: T[]
  /** Full provenance for every deduplicated item. */
  entries: CatalogEntry<T>[]
  /** Items grouped by winning sourceId. */
  bySource: Record<string, T[]>
  /** Sources that threw during fetch (partial results still included). */
  errors: Array<{ sourceId: string; error: unknown }>
}

export interface Catalog<T> {
  /** Add a source. Throws `CatalogSourceDuplicateError` if id already registered. */
  addSource(source: CatalogSource<T>): this
  /** Remove a source by id. Returns true if it existed. */
  removeSource(id: string): boolean
  /** Returns true if a source with this id is registered. */
  hasSource(id: string): boolean
  /** All registered sources, insertion-ordered. */
  getSources(): CatalogSource<T>[]
  /**
   * Fetch all sources in parallel, merge by tier priority, dedup by key.
   * Sources that throw are captured in `result.errors`; partial results
   * from successful sources are still returned.
   */
  fetch(): Promise<CatalogResult<T>>
}
