/**
 * @agentproto/operator — AIP-9 OPERATOR.md `defineOperator` reference impl.
 *
 * A single canonical operator shell — pluggable profile, skills, tools, memory, governance — that any agent runtime can implement and any conforming workflow can dispatch to.
 *
 * Spec: https://agentproto.sh/docs/aip-9
 *
 * Authoring paths:
 *   - TS:  `defineOperator({...})` → `OperatorHandle`
 *   - MD:  `parseOperatorManifest(src) → operatorFromManifest({...})` → `OperatorHandle`
 */

export const SPEC_NAME = "agentoperator/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineOperator } from "./define-operator.js"
export type { OperatorDefinition, OperatorHandle } from "./types.js"
