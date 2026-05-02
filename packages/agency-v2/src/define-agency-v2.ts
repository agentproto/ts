import { createDoctype } from "@agentproto/define-doctype"
import { agencyV2FrontmatterSchema } from "./schema.js"
import type { AgencyV2Definition, AgencyV2Handle } from "./types.js"

/**
 * AIP-21 reference implementation of `defineAgencyV2`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineAgencyV2 (AIP-21): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseAgencyV2Manifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.name
 *   readDescription: def.description.
 */
export const defineAgencyV2 = createDoctype<AgencyV2Definition, AgencyV2Handle>({
  aip: 21,
  name: "agency-v2",
  readIdentity: (def) => def.name,
  validate(def) {
    // AIP-21 rule (shared with AIP-18/20/22/23/24): appliesTo non-empty
    // ⇒ extends required. Runs before field-level zod so a structural
    // miss surfaces before the cascade of "missing required field".
    const d = def as { appliesTo?: readonly unknown[]; extends?: unknown }
    if (
      Array.isArray(d.appliesTo) &&
      d.appliesTo.length > 0 &&
      d.extends == null
    ) {
      throw new Error(
        `defineAgencyV2 (AIP-21): appliesTo is non-empty — extends MUST be set`,
      )
    }
    const result = agencyV2FrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAgencyV2 (AIP-21): ${result.error.issues
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
    return { ...def } as AgencyV2Handle
  },
})
