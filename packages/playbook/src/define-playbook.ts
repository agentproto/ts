import { createDoctype } from "@agentproto/define-doctype"
import { playbookFrontmatterSchema } from "./schema.js"
import type { PlaybookDefinition, PlaybookHandle } from "./types.js"

/**
 * AIP-12 reference implementation of `definePlaybook`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "definePlaybook (AIP-12): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parsePlaybookManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.slug
 *   readDescription: def.title.
 */
export const definePlaybook = createDoctype<PlaybookDefinition, PlaybookHandle>({
  aip: 12,
  name: "playbook",
  readIdentity: (def) => def.slug,
  readDescription: (def) => def.title,
  validate(def) {
    const result = playbookFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `definePlaybook (AIP-12): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // Cross-field binding rule (anyOf in the JSON Schema): at least
    // one of `selector` (preferred) / legacy `targets` must be present.
    const hasTargets = Array.isArray(def.targets) && def.targets.length > 0
    const selector = def.selector
    const hasSelector =
      !!selector &&
      typeof selector === "object" &&
      Object.keys(selector).length > 0
    if (!hasTargets && !hasSelector) {
      throw new Error(
        "definePlaybook (AIP-12): a binding is required — declare `selector` (preferred) or legacy `targets`",
      )
    }
    // TODO: remaining cross-field rules (kind=block-replacement →
    // `block` required). See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as PlaybookHandle
  },
})
