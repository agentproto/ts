/**
 * AIP-36 SandboxDefinition + SandboxHandle.
 *
 * TODO: fill in fields from the AIP-36 SANDBOX.md frontmatter.
 * The two universals (id + description) are the cross-AIP invariants
 * `createDoctype` enforces; everything else is spec-36-specific.
 */

export interface SandboxDefinition {
  id: string
  description: string
  // TODO: add spec-36 fields here.
}

export type SandboxHandle = Readonly<SandboxDefinition>
