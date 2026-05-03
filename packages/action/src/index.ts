/**
 * @agentproto/action — AIP-39 ACTION.md `defineAction` reference impl.
 *
 * A markdown + frontmatter format for declaring an abstract verb / operation that can be performed on a resource — its identity, semantics, side-effect profile, approval class, and lifecycle events. The pivot primitive that TOOL implements (with LLM schema), POLICY references (for grants), INTENT routes to (from user verbs), and WORKFLOW steps invoke. Bottom-up — implementations declare which actions they implement.
 *
 * Spec: https://agentproto.sh/docs/aip-39
 *
 * Authoring paths:
 *   - TS:  `defineAction({...})` → `ActionHandle`
 *   - MD:  `parseActionManifest(src) → actionFromManifest({...})` → `ActionHandle`
 */

export const SPEC_NAME = "agentaction/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineAction } from "./define-action.js"
export type { ActionDefinition, ActionHandle } from "./types.js"
export { actionSpec, actionVerbs } from "./spec.js"
export {
  parseActionManifest,
  actionFromManifest,
  actionFrontmatterSchema,
  type ActionManifest,
} from "./manifest/index.js"
