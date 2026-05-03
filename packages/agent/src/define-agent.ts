import { createDoctype } from "@agentproto/define-doctype"
import { agentFrontmatterSchema } from "./schema.js"
import type { AgentDefinition, AgentHandle } from "./types.js"

/**
 * AIP-42 reference implementation of `defineAgent`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineAgent (AIP-42): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseAgentManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineAgent = createDoctype<AgentDefinition, AgentHandle>({
  aip: 42,
  name: "agent",
  validate(def) {
    const result = agentFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAgent (AIP-42): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-42-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as AgentHandle
  },
})
