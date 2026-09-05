import { createDoctype } from "@agentproto/define-doctype"
import { workflowFrontmatterSchema } from "./schema.js"
import type { WorkflowDefinition, WorkflowHandle } from "./types.js"

/**
 * Walk every step in a manifest's `steps[]`, including nested `map` / `loop`
 * / `parallel` branch / `branch` arm bodies, and run `visit` on each. The
 * frontmatter zod schema (`schema.ts`) leaves individual step shapes as
 * `z.any()` — this is where kind-specific cross-field rules that DON'T
 * translate to zod cleanly (if/then/allOf in the JSON Schema) actually run.
 */
function walkSteps(steps: unknown, visit: (step: Record<string, unknown>) => void): void {
  if (!Array.isArray(steps)) return
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue
    const s = step as Record<string, unknown>
    visit(s)
    walkSteps(s.steps, visit)
    if (Array.isArray(s.branches)) {
      for (const br of s.branches) walkSteps((br as Record<string, unknown>)?.steps, visit)
    }
  }
}

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
    // spec-15-specific cross-field rules (if/then/allOf in the JSON
    // Schema) — these don't translate to zod cleanly, so they run here
    // instead. See @agentproto/operator's autonomy=gated rule for the
    // pattern this follows.
    walkSteps((def as { steps?: unknown }).steps, (step) => {
      if (step.kind !== "gate") return
      const command = step.command
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error(
          `defineWorkflow (AIP-15): gate step '${typeof step.id === "string" ? step.id : "(unid)"}' needs a non-empty 'command'`,
        )
      }
    })
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as WorkflowHandle
  },
})
