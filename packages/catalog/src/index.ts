/**
 * @agentproto/catalog: a multi-source, tier-aware catalog primitive.
 *
 * A multi-source, tier-aware catalog primitive. Compose N CatalogSources
 * (builtin / curated / marketplace / private / collection) and get a
 * single deduplicated fetch surface. One impl, every entity family:
 * skills, operators, integrations, runtimes, ...
 *
 * @see https://agentproto.sh/docs/agentcatalog
 */

/** Internal format id; this package implements no AIP, so it claims no registry spec name (AIP-70). */
export const CATALOG_FORMAT = "agentproto.catalog@1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

const LEGACY_SPEC_NAME = "agentcatalog/v1"
/** @deprecated Not an AIP spec name (AIP-70); kept for compatibility. */
export const SPEC_NAME: "agentcatalog/v1" = LEGACY_SPEC_NAME

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
