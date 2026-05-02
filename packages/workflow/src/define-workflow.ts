import { createDoctype } from "@agentproto/define-doctype"
import { workflowFrontmatterSchema } from "./schema.js"
import type { WorkflowDefinition, WorkflowHandle } from "./types.js"

/**
 * AIP-15 reference implementation of `defineWorkflow`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineWorkflow (AIP-15): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseWorkflowManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineWorkflow = createDoctype<WorkflowDefinition, WorkflowHandle>({
  aip: 15,
  name: "workflow",
  validate(def) {
    const result = workflowFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineWorkflow (AIP-15): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-15-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as WorkflowHandle
  },
})
