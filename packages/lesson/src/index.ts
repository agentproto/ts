/**
 * @agentproto/lesson — AIP-11 LESSON.md `defineLesson` reference impl.
 *
 * A markdown format for storing the transferable lessons an agent extracts from successful and failed runs — title, trigger, evidence, outcome — and a contract for how runtimes distill them and inject them back into future turns.
 *
 * Spec: https://agentproto.sh/docs/aip-11
 *
 * Authoring paths:
 *   - TS:  `defineLesson({...})` → `LessonHandle`
 *   - MD:  `parseLessonManifest(src) → lessonFromManifest({...})` → `LessonHandle`
 */

export const SPEC_NAME = "agentlesson/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineLesson } from "./define-lesson.js"
export type { LessonDefinition, LessonHandle } from "./types.js"
