/**
 * @agentproto/catalog — agentcatalog/v1 reference implementation.
 *
 * A multi-source, tier-aware catalog primitive. Compose N CatalogSources
 * (builtin / curated / marketplace / private / collection) and get a
 * single deduplicated fetch surface. One impl, every entity family:
 * skills, operators, integrations, runtimes, ...
 *
 * @see https://agentproto.sh/docs/agentcatalog
 */

export const SPEC_NAME = "agentcatalog/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

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
