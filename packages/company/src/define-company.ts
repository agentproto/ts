import { createDoctype } from "@agentproto/doctype"
import { canonicalizeCompany } from "./aliases.js"
import { legacyRoleFrontmatterSchema } from "./legacy-role.js"
import { companyFrontmatterSchema } from "./schema.js"
import type {
  CompanyDefinition,
  CompanyHandle,
  CompanyWarning,
} from "./types.js"

function issues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")
}

const construct = createDoctype<CompanyDefinition, CompanyHandle>({
  aip: 6,
  name: "company",
  readDescription: false,
  validate(def) {
    const doctype = (def as { doctype?: unknown }).doctype
    if (doctype === "agent") {
      throw new Error(
        "defineCompany (AIP-6): doctype 'agent' is the legacy agent slot, an AIP-42 AGENT.md: read it with @agentproto/agent",
      )
    }
    if (doctype !== "company" && doctype !== "objective" && doctype !== "role") {
      throw new Error(
        `defineCompany (AIP-6): a file MUST carry doctype (or its alias kind) 'company' or 'objective', got ${JSON.stringify(doctype)}`,
      )
    }
    const result =
      doctype === "role"
        ? legacyRoleFrontmatterSchema.safeParse(def)
        : companyFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(`defineCompany (AIP-6): ${issues(result.error)}`)
    }
  },
  build(def) {
    const warnings: CompanyWarning[] =
      (def as { doctype: string }).doctype === "role"
        ? [
            {
              code: "doctype_moved",
              message:
                "doctype 'role' under company/v1 moved to AIP-47: rewrite the file as role/v1 (id becomes name, name becomes title, mandate becomes mission and description)",
            },
          ]
        : []
    return { ...def, warnings } as unknown as CompanyHandle
  },
})

/**
 * AIP-6 reference implementation of `defineCompany`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern, top-level
 * freeze, "defineCompany (AIP-6): …" error prefix) run uniformly with every
 * other AIP defineX. `kind` and `slug` are read as `doctype` and `id` before
 * anything else (permanent aliases, `alias_conflict` when they disagree with
 * the canonical field). The handle carries the canonical names only.
 */
export function defineCompany(def: CompanyDefinition): CompanyHandle {
  return construct(
    canonicalizeCompany(def as unknown as Record<string, unknown>, "defineCompany (AIP-6)") as unknown as CompanyDefinition,
  )
}
