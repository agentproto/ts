import type { Catalog, CatalogSource } from "./types.js"

export interface CollectionSourceOptions<T> {
  /** Unique id for this collection source. */
  id: string
  /** Human-readable name, e.g. "Recommended Skills". */
  label: string
  /**
   * The parent catalog to pull items from.
   * The collection fetches from ALL other sources, then filters.
   */
  catalog: Catalog<T>
  /**
   * Explicit list of item keys to include (resolved via keyBy).
   * Takes precedence over `predicate` when both are given.
   */
  picks?: string[]
  /**
   * Predicate run against each deduplicated item. Return true to include.
   * Only used when `picks` is not provided.
   */
  predicate?: (item: T) => boolean
  /**
   * Derive a stable key from an item for matching against `picks`.
   * Must match the keyBy used in the parent catalog.
   * Defaults to inspecting `item.id`, `item.slug`, or `item.name`.
   */
  keyBy?: (item: T) => string
}

function defaultKeyBy<T>(item: T): string {
  const i = item as Record<string, unknown>
  return String(i["id"] ?? i["slug"] ?? i["name"] ?? "")
}

/**
 * A CatalogSource that curates a subset of items from a parent Catalog.
 * Use it for "Recommended", "Featured", or "Getting Started" collections
 * that pick across builtin + marketplace sources without duplicating data.
 */
export class CollectionSource<T> implements CatalogSource<T> {
  readonly tier = "collection" as const

  constructor(private readonly opts: CollectionSourceOptions<T>) {}

  get id(): string {
    return this.opts.id
  }

  get label(): string {
    return this.opts.label
  }

  async fetch(): Promise<T[]> {
    const result = await this.opts.catalog.fetch()
    const keyBy = this.opts.keyBy ?? defaultKeyBy

    if (this.opts.picks) {
      const pickSet = new Set(this.opts.picks)
      return result.items.filter((item) => pickSet.has(keyBy(item)))
    }

    if (this.opts.predicate) {
      return result.items.filter(this.opts.predicate)
    }

    return result.items
  }
}
