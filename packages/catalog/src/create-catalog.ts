import type {
  Catalog,
  CatalogEntry,
  CatalogOptions,
  CatalogResult,
  CatalogSource,
  CatalogSourceTier,
} from "./types.js"
import { DEFAULT_TIER_PRIORITY } from "./types.js"
import {
  CatalogSourceDuplicateError,
  CatalogSourceNotFoundError,
} from "./errors.js"

function defaultKeyBy<T>(item: T): string {
  const i = item as Record<string, unknown>
  const key = i["id"] ?? i["slug"] ?? i["name"]
  if (typeof key !== "string" || key === "") {
    throw new Error(
      `Could not derive a key from item: ${JSON.stringify(item)}. ` +
        "Provide a keyBy option to createCatalog().",
    )
  }
  return key
}

export function createCatalog<T>(options: CatalogOptions<T>): Catalog<T> {
  const { family, keyBy = defaultKeyBy } = options
  const tierPriority: readonly CatalogSourceTier[] =
    options.tierPriority ?? DEFAULT_TIER_PRIORITY

  const sources = new Map<string, CatalogSource<T>>()

  function tierRank(tier: CatalogSourceTier): number {
    const idx = tierPriority.indexOf(tier)
    return idx === -1 ? tierPriority.length : idx
  }

  const catalog: Catalog<T> = {
    addSource(source) {
      if (sources.has(source.id)) {
        throw new CatalogSourceDuplicateError(family, source.id)
      }
      sources.set(source.id, source)
      return catalog
    },

    removeSource(id) {
      if (!sources.has(id)) {
        throw new CatalogSourceNotFoundError(family, id)
      }
      return sources.delete(id)
    },

    hasSource(id) {
      return sources.has(id)
    },

    getSources() {
      return Array.from(sources.values())
    },

    async fetch(): Promise<CatalogResult<T>> {
      const allSources = Array.from(sources.values())

      const settled = await Promise.allSettled(
        allSources.map(async (s) => ({ source: s, items: await s.fetch() })),
      )

      const errors: CatalogResult<T>["errors"] = []
      const bySourceRaw = new Map<string, T[]>()

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!
        const source = allSources[i]!
        if (result.status === "fulfilled") {
          bySourceRaw.set(source.id, result.value.items)
        } else {
          errors.push({ sourceId: source.id, error: result.reason })
        }
      }

      // Dedup by key — highest-priority tier (lowest tierRank) wins
      const entryMap = new Map<string, CatalogEntry<T>>()

      for (const [sourceId, items] of bySourceRaw) {
        const source = sources.get(sourceId)!
        for (const item of items) {
          const key = keyBy(item)
          const existing = entryMap.get(key)
          if (!existing) {
            entryMap.set(key, { item, sourceId, alternateSources: [] })
          } else {
            const existingTierRank = tierRank(sources.get(existing.sourceId)!.tier)
            const newTierRank = tierRank(source.tier)
            if (newTierRank < existingTierRank) {
              // New source wins — demote current winner to alternate
              entryMap.set(key, {
                item,
                sourceId,
                alternateSources: [existing.sourceId, ...existing.alternateSources],
              })
            } else {
              existing.alternateSources.push(sourceId)
            }
          }
        }
      }

      const entries = Array.from(entryMap.values())
      const items = entries.map((e) => e.item)

      const bySource: Record<string, T[]> = {}
      for (const entry of entries) {
        ;(bySource[entry.sourceId] ??= []).push(entry.item)
      }

      return { items, entries, bySource, errors }
    },
  }

  return catalog
}
