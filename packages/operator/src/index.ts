/**
 * @agentproto/operator — AIP-9 OPERATOR.md `defineOperator` reference impl.
 *
 * A single canonical operator shell — pluggable profile, skills, tools,
 * memory, governance — that any agent runtime can implement and any
 * conforming workflow can dispatch to.
 *
 * Spec: https://agentproto.sh/docs/aip-9
 *
 * Authoring paths:
 *   - TS:  `defineOperator({...})` → `OperatorHandle`
 *   - MD:  `parseOperatorManifest(src) → operatorFromManifest({...})` → `OperatorHandle`
 */

/** Canonical AIP-9 name from the AIP-70 names registry. */
export const SPEC_NAME = "operator/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineOperator } from "./define-operator.js"
export { renderOperatorMd, type OperatorRenderInput } from "./render.js"
export { operatorSpec, operatorVerbs } from "./spec.js"
export type {
  AgentSkillRef,
  AgentToolRef,
  Autonomy,
  DefineOperatorOptions,
  LegacyGovernance,
  LegacyMemory,
  LegacyScopedToolRef,
  LegacySkillRef,
  McpToolRef,
  MemoryKind,
  MemoryPolicy,
  OperatorDefinition,
  OperatorGovernance,
  OperatorHandle,
  OperatorMemory,
  OperatorParticipation,
  OperatorProfile,
  OperatorRole,
  OperatorRoleBinding,
  OperatorRuntime,
  OperatorWarning,
  ParticipationMode,
  RoleSlotValue,
  SkillRef,
  ToolRef,
} from "./types.js"

export { resolveOperator } from "./resolve.js"
export { toolDenyGrants } from "./resolve-tools.js"
export { OperatorResolutionError, ROLE_CHAIN_MAX } from "./resolve-types.js"
export type {
  IdentityEntry,
  OperatorEntry,
  OperatorSources,
  PersonaEntry,
  ResolutionErrorCode,
  ResolutionIssue,
  ResolutionWarning,
  ResolutionWarningCode,
  ResolvedOperator,
} from "./resolve-types.js"
