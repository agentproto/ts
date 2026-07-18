import { createDoctype } from "@agentproto/define-doctype"
import { workspaceFrontmatterSchema } from "./schema.js"
import type { WorkspaceDefinition, WorkspaceHandle } from "./types.js"

/**
 * AIP-34 reference implementation of `defineWorkspace`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineWorkspace (AIP-34): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseWorkspaceManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.id
 *   readDescription: def.name.
 */
export const defineWorkspace = createDoctype<WorkspaceDefinition, WorkspaceHandle>({
  aip: 34,
  name: "workspace",
  // AIP-34 ids are ALWAYS scoped `@<owner-slug>/<workspace-slug>` (see the
  // `id` regex in schema.ts). The generic DEFAULT_ID_PATTERN is a bare kebab
  // slug and rejects the `@`/`/`, so without this the constructDoctype id
  // gate throws before validate() on every spec-compliant id. Mirror the
  // schema pattern here so the two gates agree.
  idPattern: /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
  readDescription: (def) => def.name,
  validate(def) {
    const result = workspaceFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineWorkspace (AIP-34): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-34-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as WorkspaceHandle
  },
})
