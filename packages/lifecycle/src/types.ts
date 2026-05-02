/**
 * AIP-37 LifecycleDefinition + LifecycleHandle.
 *
 * TODO: fill in fields from the AIP-37 LIFECYCLE.md frontmatter.
 * The two universals (id + description) are the cross-AIP invariants
 * `createDoctype` enforces; everything else is spec-37-specific.
 */

export interface LifecycleDefinition {
  id: string
  description: string
  // TODO: add spec-37 fields here.
}

export type LifecycleHandle = Readonly<LifecycleDefinition>
