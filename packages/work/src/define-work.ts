import { createDoctype } from "@agentproto/doctype"
import { workFrontmatterSchema } from "./schema.js"
import type { WorkDefinition, WorkHandle } from "./types.js"

/**
 * AIP-20 reference implementation of `defineWork`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineWork (AIP-20): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseWorkManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.name
 *   readDescription: def.description.
 */
export const defineWork = createDoctype<WorkDefinition, WorkHandle>({
  aip: 20,
  name: "work",
  readIdentity: (def) => def.name,
  validate(def) {
    // Cross-field rules run BEFORE field-level zod so structural
    // errors surface before the cascade of "missing required field".
    //
    // AIP-20 dropped view mode entirely: `extends` / `appliesTo` are no
    // longer part of the WORK manifest (additionalProperties: false), so
    // the old "appliesTo non-empty ⇒ extends required" rule is gone with
    // it — the redesigned draft carries no active cross-field rule yet.
    const result = workFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineWork (AIP-20): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as WorkHandle
  },
})
