import { createDoctype } from "@agentproto/define-doctype"
import { actionFrontmatterSchema } from "./schema.js"
import type { ActionDefinition, ActionHandle } from "./types.js"

/**
 * AIP-39 reference implementation of `defineAction`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineAction (AIP-39): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseActionManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineAction = createDoctype<ActionDefinition, ActionHandle>({
  aip: 39,
  name: "action",
  // Action ids are namespaced `<target_kind>:<verb>` (`secrets:reveal`,
  // `storage:commit`). Override createDoctype's default kebab-only
  // pattern; the schema's own id regex (stricter) runs inside zod.
  idPattern: /^[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)?$/,
  validate(def) {
    const result = actionFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAction (AIP-39): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-39-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as ActionHandle
  },
})
