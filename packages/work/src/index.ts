/**
 * @agentproto/work — AIP-20 WORK.md `defineWork` reference impl.
 *
 * A workspace-only successor to AIP-13 that drops hardcoded project/initiative/task doctypes and delegates all per-item-kind schema work to AIP-18 collections — owning only the work-root manifest (containment rules, status rollups, coordination, saved views) and cross-AIP composition. View mode (`extends` / `appliesTo`) was removed by the AIP-20 redesign.
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
