import { createDoctype } from "@agentproto/define-doctype"
import { packFrontmatterSchema } from "./schema.js"
import type { PackDefinition, PackHandle, PackStatus } from "./types.js"

/**
 * AIP-52 reference implementation of `definePack`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "definePack (AIP-52): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parsePackManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 *
 * Identity / description extractors detected from the JSON Schema:
 *   readIdentity: def.name
 *   readDescription: def.description.
 */
export const definePack = createDoctype<PackDefinition, PackHandle>({
  aip: 52,
  name: "pack",
  readIdentity: (def) => def.name,
  readDescription: (def) => def.description,
  validate(def) {
    const result = packFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `definePack (AIP-52): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // Cross-field plugin rule: the plugin must be resolvable — either
    // built inline from ./skills/ or assembled from published includes.
    const hasInline = def.plugin.inline === true
    const hasIncludes =
      Array.isArray(def.plugin.includes) && def.plugin.includes.length > 0
    if (!hasInline && !hasIncludes) {
      throw new Error(
        "definePack (AIP-52): plugin requires either `inline: true` or a non-empty `includes` list",
      )
    }
    // Cross-field pricing rule: a priced bundle must have a positive
    // bundle price.
    if (def.pricing && def.pricing.bundle <= 0) {
      throw new Error(
        "definePack (AIP-52): pricing.bundle must be > 0 when pricing is present",
      )
    }
  },
  build(def) {
    // Derive lifecycle status: blockers gate the pack; otherwise the
    // plugin's resolution shape drives the state.
    const hasBlockers =
      Array.isArray(def.blockers) && def.blockers.length > 0
    const hasInline = def.plugin.inline === true
    const hasIncludes =
      Array.isArray(def.plugin.includes) && def.plugin.includes.length > 0

    let status: PackStatus
    if (hasBlockers) {
      status = "gated"
    } else if (!hasInline && !hasIncludes) {
      // Defensive — validate() rejects this before build() ever runs.
      status = "planned"
    } else if (hasInline) {
      status = "ready"
    } else {
      status = "assembling"
    }

    return { ...def, status } as PackHandle
  },
})