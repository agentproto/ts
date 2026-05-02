import { createDoctype } from "@agentproto/define-doctype"
import { collectionFrontmatterSchema } from "./schema.js"
import type { CollectionDefinition, CollectionHandle } from "./types.js"

/**
 * AIP-18 reference implementation of `defineCollection`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineCollection (AIP-18): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseCollectionManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineCollection = createDoctype<CollectionDefinition, CollectionHandle>({
  aip: 18,
  name: "collection",
  validate(def) {
    const result = collectionFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineCollection (AIP-18): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-18-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as CollectionHandle
  },
})
