import { createDoctype } from "@agentproto/define-doctype"
import { codeFrontmatterSchema } from "./schema.js"
import type { CodeDefinition, CodeHandle } from "./types.js"

/**
 * AIP-26 reference implementation of `defineCode`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineCode (AIP-26): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseCodeManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineCode = createDoctype<CodeDefinition, CodeHandle>({
  aip: 26,
  name: "code",
  validate(def) {
    const result = codeFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineCode (AIP-26): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-26-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as CodeHandle
  },
})
