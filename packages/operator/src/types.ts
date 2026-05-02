/**
 * AIP-9 OperatorDefinition + OperatorHandle.
 *
 * TODO: fill in fields from the AIP-9 OPERATOR.md frontmatter.
 * The two universals (id + description) are the cross-AIP invariants
 * `createDoctype` enforces; everything else is spec-9-specific.
 */

export interface OperatorDefinition {
  id: string
  description: string
  // TODO: add spec-9 fields here.
}

export interface OperatorHandle {
  readonly id: string
  readonly description: string
  // TODO: add the frozen handle shape here, mirroring OperatorDefinition
  // with sensible defaults applied.
}
