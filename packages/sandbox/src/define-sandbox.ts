import { createDoctype } from "@agentproto/define-doctype"
import { sandboxFrontmatterSchema } from "./schema.js"
import type { SandboxDefinition, SandboxHandle } from "./types.js"

/**
 * AIP-36 reference implementation of `defineSandbox`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineSandbox (AIP-36): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseSandboxManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.id
 *   readDescription: skipped (no string-y required field detected).
 */
export const defineSandbox = createDoctype<SandboxDefinition, SandboxHandle>({
  aip: 36,
  name: "sandbox",
  readDescription: false,
  validate(def) {
    const result = sandboxFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineSandbox (AIP-36): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-36-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as SandboxHandle
  },
})
