import { createDoctype } from "@agentproto/define-doctype"
import { runnerFrontmatterSchema } from "./schema.js"
import type { RunnerDefinition, RunnerHandle } from "./types.js"

/**
 * AIP-17 reference implementation of `defineRunner`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineRunner (AIP-17): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseRunnerManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineRunner = createDoctype<RunnerDefinition, RunnerHandle>({
  aip: 17,
  name: "runner",
  validate(def) {
    const result = runnerFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineRunner (AIP-17): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-17-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as RunnerHandle
  },
})
