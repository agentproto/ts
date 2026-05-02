/**
 * @agentproto/work — AIP-20 WORK.md `defineWork` reference impl.
 *
 * A workspace-only successor to AIP-13 that drops hardcoded project/initiative/task doctypes and delegates all per-item-kind schema work to AIP-18 collections — owning only the workspace root manifest, scope axes, status rollups, and cross-AIP composition.
 *
 * Spec: https://agentproto.sh/docs/aip-20
 *
 * Authoring paths:
 *   - TS:  `defineWork({...})` → `WorkHandle`
 *   - MD:  `parseWorkManifest(src) → workFromManifest({...})` → `WorkHandle`
 */

export const SPEC_NAME = "agentwork/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineWork } from "./define-work.js"
export type { WorkDefinition, WorkHandle } from "./types.js"
