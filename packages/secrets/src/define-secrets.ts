import { createDoctype } from "@agentproto/define-doctype"
import { secretsFrontmatterSchema } from "./schema.js"
import type { SecretsDefinition, SecretsHandle } from "./types.js"

/**
 * AIP-19 reference implementation of `defineSecrets`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineSecrets (AIP-19): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseSecretsManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.id
 *   readDescription: skipped (no string-y required field detected).
 */
export const defineSecrets = createDoctype<SecretsDefinition, SecretsHandle>({
  aip: 19,
  name: "secrets",
  readDescription: false,
  validate(def) {
    const result = secretsFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineSecrets (AIP-19): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-19-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as SecretsHandle
  },
})
