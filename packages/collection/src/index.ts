/**
 * @agentproto/collection — AIP-18 COLLECTION.md `defineCollection` reference impl.
 *
 * A composable primitive pack that lets any AIP define domain-extensible item types as on-disk schema files (`COLLECTION.md`) instantiated by markdown records (`ITEM.md`), so future workspace AIPs (work, knowledge, companies) compose on a shared type system instead of inventing their own.
 *
 * Spec: https://agentproto.sh/docs/aip-18
 *
 * Authoring paths:
 *   - TS:  `defineCollection({...})` → `CollectionHandle`
 *   - MD:  `parseCollectionManifest(src) → collectionFromManifest({...})` → `CollectionHandle`
 */

export const SPEC_NAME = "agentcollection/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineCollection } from "./define-collection.js"
export type { CollectionDefinition, CollectionHandle } from "./types.js"
