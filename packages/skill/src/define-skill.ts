import { createDoctype } from "@agentproto/define-doctype"
import { skillFrontmatterSchema } from "./schema.js"
import type { SkillDefinition, SkillHandle } from "./types.js"

/**
 * AIP-3 reference implementation of `defineSkill`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineSkill (AIP-3): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseSkillManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 *
 * Cross-field rules — variant=executable requires `metadata.aip3.execution`;
 * variant=composite requires non-empty `metadata.aip3.uses` — run after
 * the zod check so callers see one consistent error path.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.name
 *   readDescription: def.description.
 */
export const defineSkill = createDoctype<SkillDefinition, SkillHandle>({
  aip: 3,
  name: "skill",
  readIdentity: (def) => def.name,
  validate(def) {
    const result = skillFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineSkill (AIP-3): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }

    const aip3 = result.data.metadata?.aip3
    if (!aip3) return

    const variant = aip3.variant ?? "instruction"
    if (variant === "executable" && !aip3.execution) {
      throw new Error(
        "defineSkill (AIP-3): metadata.aip3.execution is required when metadata.aip3.variant=executable",
      )
    }
    if (variant === "composite" && (!aip3.uses || aip3.uses.length === 0)) {
      throw new Error(
        "defineSkill (AIP-3): metadata.aip3.uses must be non-empty when metadata.aip3.variant=composite",
      )
    }
  },
  build(def) {
    return { ...def } as SkillHandle
  },
})
