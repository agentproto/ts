import { createDoctype } from "@agentproto/define-doctype"
import { extensionFrontmatterSchema } from "./schema.js"
import type { ExtensionDefinition, ExtensionHandle } from "./types.js"

/**
 * AIP-40 reference implementation of `defineExtension`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineExtension (AIP-40): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseExtensionManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.slug
 *   readDescription: def.description.
 */
export const defineExtension = createDoctype<ExtensionDefinition, ExtensionHandle>({
  aip: 40,
  name: "extension",
  // Extension slugs are namespaced: `<namespace>:<name>` (e.g.
  // `acme:deal`). Override the default kebab-only pattern.
  idPattern: /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*[a-z0-9]$/,
  readIdentity: (def) => def.slug,
  validate(def) {
    const result = extensionFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineExtension (AIP-40): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-40-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as ExtensionHandle
  },
})
