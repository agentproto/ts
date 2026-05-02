/**
 * AIP-34 WorkspaceDefinition + WorkspaceHandle.
 *
 * TODO: fill in fields from the AIP-34 WORKSPACE.md frontmatter.
 * The two universals (id + description) are the cross-AIP invariants
 * `createDoctype` enforces; everything else is spec-34-specific.
 */

export interface WorkspaceDefinition {
  id: string
  description: string
  // TODO: add spec-34 fields here.
}

export type WorkspaceHandle = Readonly<WorkspaceDefinition>
