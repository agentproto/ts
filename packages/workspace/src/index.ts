/**
 * @agentproto/workspace — AIP-34 WORKSPACE.md `defineWorkspace` reference impl.
 *
 * A markdown + frontmatter format for declaring a workspace's identity — globally addressable id, owner, storage choice, defaults, publish posture. The root manifest of every AIP-organized workspace; pairs with STORAGE.md (AIP-35) for the storage policy block.
 *
 * Spec: https://agentproto.sh/docs/aip-34
 *
 * Authoring paths:
 *   - TS:  `defineWorkspace({...})` → `WorkspaceHandle`
 *   - MD:  `parseWorkspaceManifest(src) → workspaceFromManifest({...})` → `WorkspaceHandle`
 */

export const SPEC_NAME = "agentworkspace/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineWorkspace } from "./define-workspace.js"
export type { WorkspaceDefinition, WorkspaceHandle } from "./types.js"
