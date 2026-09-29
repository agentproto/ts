import { createDoctype } from "@agentproto/define-doctype"
import { knowledgeFrontmatterSchema } from "./schema.js"
import type { KnowledgeDefinition, KnowledgeHandle } from "./types.js"

/**
 * AIP-10 reference implementation of `defineKnowledge`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineKnowledge (AIP-10): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseKnowledgeManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineKnowledge = createDoctype<KnowledgeDefinition, KnowledgeHandle>({
  aip: 10,
  name: "knowledge",
  // AIP-10 has three branches with different identity fields:
  //   entry  → slug
  //   source → id
  //   workspace → name
  // Dispatch on the `schema` discriminator so the cross-AIP id-pattern
  // check runs against the right token.
  readIdentity: (def: KnowledgeDefinition) => {
    switch (def.schema) {
      case "knowledge.entry/v1":
        return def.slug
      case "knowledge.source/v1":
        return def.id
      case "knowledge.workspace/v1":
        return def.name
      default:
        return ""
    }
  },
  // Union of the three branches' identity patterns (slug / name:
  // `^[a-z][a-z0-9-]*[a-z0-9]$`, id: `^[a-z0-9][a-z0-9-]*$`, all 2-96
  // chars). The cross-AIP default caps at 80 chars and allows `.`/`_`,
  // so it rejects valid 81-96 char identities. The exact per-branch
  // shape is enforced by the schema-derived zod in `validate()`.
  idPattern: /^[a-z0-9][a-z0-9-]{1,95}$/,
  // `knowledge.entry/v1` and `knowledge.source/v1` have no `description`
  // field, so the cross-AIP default (`def.description`, required)
  // rejected every valid entry and source. The workspace branch's
  // `description` (required, 1-2000) is enforced by the zod below.
  readDescription: false,
  validate(def) {
    // AIP-10 workspace rule (`allOf[if appliesTo minItems 1 then
    // required extends]`): a view MUST extend a parent. Runs before the
    // zod check so it reports the structural error, not a cascade.
    const w = def as { schema?: string; appliesTo?: unknown; extends?: unknown }
    if (
      w.schema === "knowledge.workspace/v1" &&
      Array.isArray(w.appliesTo) &&
      w.appliesTo.length > 0 &&
      w.extends == null
    ) {
      throw new Error(`defineKnowledge (AIP-10): appliesTo is non-empty — extends MUST be set`)
    }
    const result = knowledgeFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineKnowledge (AIP-10): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
  },
  build(def) {
    // Use the zod output so schema defaults are applied and timestamps
    // are normalised to ISO strings, matching the .md manifest path.
    return knowledgeFrontmatterSchema.parse(def) as unknown as KnowledgeHandle
  },
})
