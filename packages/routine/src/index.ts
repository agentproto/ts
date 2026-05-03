/**
 * @agentproto/routine — AIP-41 ROUTINE.md `defineRoutine` reference impl.
 *
 * A markdown + frontmatter format for declaring a recurring or event-driven invocation of an action, workflow, or tool. Decouples "when" (the schedule) from "what" (the target). Supports cron / interval / calendar / manual / event-driven schedules, with retry, jitter, catchup policy, identity attribution, and failure routing.
 *
 * Spec: https://agentproto.sh/docs/aip-41
 *
 * Authoring paths:
 *   - TS:  `defineRoutine({...})` → `RoutineHandle`
 *   - MD:  `parseRoutineManifest(src) → routineFromManifest({...})` → `RoutineHandle`
 */

export const SPEC_NAME = "agentroutine/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineRoutine } from "./define-routine.js"
export type { RoutineDefinition, RoutineHandle } from "./types.js"
export { routineSpec, routineVerbs } from "./spec.js"
export {
  parseRoutineManifest,
  routineFromManifest,
  routineFrontmatterSchema,
  type RoutineManifest,
} from "./manifest/index.js"
