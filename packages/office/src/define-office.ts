import { createDoctype } from "@agentproto/define-doctype"
import { officeFrontmatterSchema } from "./schema.js"
import type { OfficeDefinition, OfficeHandle } from "./types.js"

/**
 * AIP-22 reference implementation of `defineOffice`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineOffice (AIP-22): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseOfficeManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.name
 *   readDescription: def.description.
 */
export const defineOffice = createDoctype<OfficeDefinition, OfficeHandle>({
  aip: 22,
  name: "office",
  readIdentity: (def) => def.name,
  validate(def) {
    // Cross-field rules run BEFORE field-level zod so structural
    // errors surface before the cascade of "missing required field".
    //
    // AIP-22 rule: appliesTo non-empty ⇒ extends required.
    const d = def as { appliesTo?: readonly unknown[]; extends?: unknown }
    if (
      Array.isArray(d.appliesTo) &&
      d.appliesTo.length > 0 &&
      d.extends == null
    ) {
      throw new Error(
        `defineOffice (AIP-22): appliesTo is non-empty — extends MUST be set`,
      )
    }
    const result = officeFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineOffice (AIP-22): ${result.error.issues
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
    return { ...def } as OfficeHandle
  },
})
