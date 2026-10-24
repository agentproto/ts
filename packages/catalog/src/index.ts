/**
 * @agentproto/catalog: a multi-source, tier-aware catalog primitive.
 *
 * A multi-source, tier-aware catalog primitive. Compose N CatalogSources
 * (builtin / curated / marketplace / private / collection) and get a
 * single deduplicated fetch surface. One impl, every entity family:
 * skills, operators, integrations, runtimes, ...
 *
 * This package is not itself an AIP registry spec; its data format is
 * identified by {@link CATALOG_FORMAT}.
 */

/** Internal data-format id (not an AIP registry spec name); see AIP-70. */
export const CATALOG_FORMAT = "agentproto.catalog/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

/**
 * @deprecated Not an AIP spec name; use {@link CATALOG_FORMAT} instead.
 * Kept for backward compatibility.
 */
export const SPEC_NAME = "agentcatalog/v1" as const

export { createCatalog } from "./create-catalog.js"
export { CollectionSource, type CollectionSourceOptions } from "./collection-source.js"
export {
  CatalogSourceDuplicateError,
  CatalogSourceNotFoundError,
} from "./errors.js"
export {
  DEFAULT_TIER_PRIORITY,
  type Catalog,
  type CatalogEntry,
  type CatalogOptions,
  type CatalogResult,
  type CatalogSource,
  type CatalogSourceTier,
} from "./types.js"
