/**
 * @agentproto/workspace — AIP-34 WORKSPACE.md `defineWorkspace` reference impl.
 *
 * A markdown + frontmatter format for declaring a workspace's identity — globally addressable id, owner, storage choice, defaults, publish posture. The root manifest of every AIP-organized workspace; pairs with STORAGE.md (AIP-35) for the storage policy block.
 *
 * `workspace/v2` (additive, see AIP-34 §Specification (workspace/v2 — extended))
 * composes many workspaces into one tree: node type (TYPES.md), four wall
 * levels, two-sided includes/exports, never-inherited secrets, versioned
 * apps (agentproto.lock), and budget aggregation. v1 is unchanged.
 *
 * Spec: https://agentproto.sh/docs/aip-34
 *
 * Authoring paths (v1):
 *   - TS:  `defineWorkspace({...})` → `WorkspaceHandle`
 *   - MD:  `parseWorkspaceManifest(src) → workspaceFromManifest({...})` → `WorkspaceHandle`
 *
 * Authoring paths (v2) — ONE schema (`workspaceV2FrontmatterSchema`) backs
 * all three:
 *   - TS → handle:     `defineWorkspaceV2({...})` → `WorkspaceHandleV2`
 *   - TS → .md:        `writeWorkspaceV2Manifest(def, body)` → string
 *   - .md → handle:    `parseWorkspaceV2Manifest(src) → workspaceV2FromManifest({...})`
 *   - tree → report:   `checkWorkspaceTree(rootDir)` (`./checker`) — cross-node
 *                       rules (type/wall/includes/secrets/budgets) a single
 *                       manifest can't check on its own.
 */

export const SPEC_NAME = "agentworkspace/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const
export const SPEC_NAME_V2 = "agentworkspace/v2" as const

export { defineWorkspace } from "./define-workspace.js"
export type { WorkspaceDefinition, WorkspaceHandle } from "./types.js"

export { defineWorkspaceV2 } from "./define-workspace-v2.js"
export type { WorkspaceDefinitionV2, WorkspaceHandleV2 } from "./types-v2.js"
export { workspaceV2FrontmatterSchema } from "./schema-v2.js"
export type { WorkspaceV2Frontmatter } from "./schema-v2.js"

export {
  typesManifestSchema,
  parseTypesManifest,
  writeTypesManifest,
  resolveTypeEntry,
} from "./types-registry.js"
export type { TypesManifestFrontmatter, TypeEntry } from "./types-registry.js"

export { agentprotoLockSchema, parseLock, writeLock } from "./lock.js"
export type { AgentprotoLock, LockedApp, LockedPack } from "./lock.js"

export {
  exportManifestSchema,
  parseExportManifest,
  writeExportManifest,
} from "./export-manifest.js"
export type { ExportManifestFrontmatter, ExportManifest } from "./export-manifest.js"
