import { createDoctype } from "@agentproto/define-doctype"
import { assemblyFrontmatterSchema } from "./schema.js"
import type { AssemblyDefinition, AssemblyHandle } from "./types.js"

/**
 * AIP-24 reference implementation of `defineAssembly`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineAssembly (AIP-24): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseAssemblyManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.name
 *   readDescription: def.description.
 */
export const defineAssembly = createDoctype<AssemblyDefinition, AssemblyHandle>({
  aip: 24,
  name: "assembly",
  readIdentity: (def) => def.name,
  validate(def) {
    // Cross-field rules run BEFORE field-level zod so structural
    // errors surface before the cascade of "missing required field".
    const d = def as {
      appliesTo?: readonly unknown[]
      extends?: unknown
      defaults?: { triggerHeuristic?: string; triggerInterval_ms?: number }
    }
    // AIP-24 rule #1 (shared with AIP-18/20/22/23): appliesTo non-empty
    // ⇒ extends required.
    if (
      Array.isArray(d.appliesTo) &&
      d.appliesTo.length > 0 &&
      d.extends == null
    ) {
      throw new Error(
        `defineAssembly (AIP-24): appliesTo is non-empty — extends MUST be set`,
      )
    }
    // AIP-24 rule #2: triggerHeuristic="periodic" demands an explicit
    // interval — without one the runtime has no schedule.
    if (
      d.defaults?.triggerHeuristic === "periodic" &&
      d.defaults?.triggerInterval_ms === undefined
    ) {
      throw new Error(
        `defineAssembly (AIP-24): defaults.triggerHeuristic='periodic' requires defaults.triggerInterval_ms`,
      )
    }
    const result = assemblyFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAssembly (AIP-24): ${result.error.issues
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
    return { ...def } as AssemblyHandle
  },
})
