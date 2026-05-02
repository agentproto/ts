import { createDoctype } from "@agentproto/define-doctype"
import type { LessonDefinition, LessonHandle } from "./types.js"

/**
 * AIP-11 reference implementation of `defineLesson`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineLesson (AIP-11): …"
 * error prefix) run uniformly with every other AIP defineX. Spec-11-
 * specific validation goes in `validate(def)`; defaulting and nested
 * freezing in `build(def)`.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.slug
 *   readDescription: def.title.
 */
export const defineLesson = createDoctype<LessonDefinition, LessonHandle>({
  aip: 11,
  name: "lesson",
  readIdentity: (def) => def.slug,
  readDescription: (def) => def.title,
  validate(_def) {
    // TODO: spec-11-specific checks (cross-field rules, ref patterns,
    // length caps that the JSON Schema couldn't express). Length and
    // pattern constraints on individual fields already run inside the
    // manifest's zod schema when the .md path is taken.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as LessonHandle
  },
})
