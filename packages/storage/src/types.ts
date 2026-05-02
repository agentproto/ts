/**
 * AIP-35 StorageDefinition + StorageHandle.
 *
 * TODO: fill in fields from the AIP-35 STORAGE.md frontmatter.
 * The two universals (id + description) are the cross-AIP invariants
 * `createDoctype` enforces; everything else is spec-35-specific.
 */

export interface StorageDefinition {
  id: string
  description: string
  // TODO: add spec-35 fields here.
}

export type StorageHandle = Readonly<StorageDefinition>
