/**
 * @agentproto/workspace — AIP-34 WORKSPACE.md `defineWorkspace` reference impl.
 *
 * `workspace/v2` — the canonical, only schema this AIP defines. It
 * composes many workspaces into one tree: node type (TYPES.md), four wall
 * levels, two-sided includes/exports/apps doors, never-inherited secrets,
 * versioned app attachments (agentproto.lock), and budget aggregation.
 * Supersedes an earlier `workspace/v1` (identity-only, no tree) outright —
 * there is no v1 schema or v1 path left in this package. See AIP-34
 * §Migrating from workspace/v1.
 *
 * Spec: https://agentproto.sh/docs/aip-34
 *
 * Authoring paths — ONE schema (`workspaceFrontmatterSchema`) backs all
 * three, so load/export/verify can never drift from each other:
 *   - TS → handle:     `defineWorkspace({...})` → `WorkspaceHandle`
 *   - TS → .md:        `writeWorkspaceManifest(def, body)` → string
 *   - .md → handle:    `parseWorkspaceManifest(src) → workspaceFromManifest({...})`
 *   - tree → report:   `checkWorkspaceTree(rootDir)` (`./checker`) — cross-node
 *                       rules (type/wall/includes/apps/secrets/budgets) a
 *                       single manifest can't check on its own.
 */

export const SPEC_NAME = "workspace/v2" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineWorkspace } from "./define-workspace.js"
export type { WorkspaceDefinition, WorkspaceHandle } from "./types.js"
export { workspaceFrontmatterSchema, workspaceStatusSchema } from "./schema.js"
export type { WorkspaceFrontmatter, WorkspaceStatus } from "./schema.js"

export { computeEffectiveStatus } from "./effective-status.js"
export type { EffectiveStatusAncestor, EffectiveStatusResult } from "./effective-status.js"

export {
  typesManifestSchema,
  parseTypesManifest,
  writeTypesManifest,
  resolveTypeEntry,
  validateTypesRegistry,
} from "./types-registry.js"
export type {
  TypesManifestFrontmatter,
  TypesManifestFrontmatterInput,
  TypeEntry,
  TypesRegistryIssue,
} from "./types-registry.js"

export {
  WALL_LEVELS,
  wallRank,
  strictestWall,
  NodeScopeError,
  resolveNodeScope,
  nodeChain,
  nodeProjection,
  composeNodeChainPolicy,
} from "./node-scope.js"
export type {
  WallLevel,
  TreeNode,
  NodeTree,
  NodeScope,
  NodeProjection,
  ChainPolicyDocument,
  OriginGrant,
  ComposedNodePolicy,
  PolicyDecision,
} from "./node-scope.js"

export { agentprotoLockSchema, parseLock, writeLock } from "./lock.js"
export type { AgentprotoLock, AgentprotoLockInput, LockedApp, LockedPack } from "./lock.js"

export {
  exportManifestSchema,
  parseExportManifest,
  writeExportManifest,
} from "./export-manifest.js"
export type { ExportManifestFrontmatter, ExportManifestFrontmatterInput, ExportManifest } from "./export-manifest.js"
