import { createDoctype } from "@agentproto/define-doctype"
import { lessonFrontmatterSchema } from "./schema.js"
import type { LessonDefinition, LessonHandle } from "./types.js"

/**
 * AIP-11 reference implementation of `defineLesson`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineLesson (AIP-11): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseLessonManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
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
  validate(def) {
    const result = lessonFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineLesson (AIP-11): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-11-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as LessonHandle
  },
})
