/**
 * @agentproto/ref-catalog — AIP-54 reference implementation.
 *
 * One typed, cross-AIP reference primitive: `ArtifactRef` ({aip, id,
 * version}) + `aip://` URI serialization, resolved through per-family
 * AIP-43 registries joined by `RefCatalog`. One reference mechanism
 * for every AIP, replacing per-primitive xRef fields.
 *
 * @see https://agentproto.sh/docs/aip-54
 */

export const SPEC_NAME = "ref/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export {
  RefCatalog,
  refFor,
  refToUri,
  refFromUri,
  type RefCatalogOptions,
} from "./ref-catalog.js"
export {
  RefFamilyError,
  RefUnresolvableError,
  type ArtifactRef,
  type FamilySpec,
  type RefKeyableHandle,
  type RefRegistryLike,
  type ResolvedArtifact,
} from "./types.js"
