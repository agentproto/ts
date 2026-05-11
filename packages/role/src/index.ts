/**
 * @agentproto/role — AIP-47 ROLE.md `defineRole` reference impl.
 *
 * A single-doc markdown + frontmatter format for portable organizational roles — mission, responsibilities, capabilities, tools, KPIs, seniority, reporting line, lifecycle hooks. Sibling to AIP-25 PERSONA (face) and AIP-23 IDENTITY (substance); referenced by AIP-9 OPERATOR (`role:` field) and AIP-6 COMPANY (`roles/<slug>/ROLE.md` doctype). Roles describe what a job is — independent of who holds it (persona/identity) and which instance is hired (operator).
 *
 * Spec: https://agentproto.sh/docs/aip-47
 *
 * Authoring paths:
 *   - TS:  `defineRole({...})` → `RoleHandle`
 *   - MD:  `parseRoleManifest(src) → roleFromManifest({...})` → `RoleHandle`
 *
 * Resolution:
 *   - `resolveRole(ref, { sources })` walks the `extends` chain, applies
 *     strategic merge per the spec, and returns the effective `RoleHandle`
 *     plus the merged body, the resolution chain, and any warnings.
 *
 * Composition (advisory, never grants access):
 *   - Operators consume the resolved role via AIP-9 OPERATOR `role:`
 *     field. Effective permissions come from AIP-38 POLICY, NOT from
 *     the role — see AIP-47 §Role vs Policy vs Governance.
 */

export const SPEC_NAME = "agentrole/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

/**
 * Seniority levels per AIP-47 §Optional fields. Const tuple exported
 * so consumers can derive zod / openapi enum schemas from the single
 * source of truth — keep this in sync with `ROLE.schema.json`.
 */
export const ROLE_SENIORITIES = [
  "intern",
  "junior",
  "mid",
  "senior",
  "lead",
  "principal",
  "executive",
] as const
export type RoleSeniority = (typeof ROLE_SENIORITIES)[number]

/**
 * Recommended departments per AIP-47 §Departments (informative).
 * `department` on a ROLE.md is a free string — these values are
 * suggested for cross-runtime alignment. Runtimes that group / chart
 * roles by department SHOULD render this list as the default
 * taxonomy and treat any out-of-list value as a domain-specific
 * extension (legal, R&D, clinical, …).
 *
 * Order is significant: the array order is the recommended display
 * order for org charts and "hire" UIs.
 */
export const RECOMMENDED_DEPARTMENTS = [
  "executive",
  "operations",
  "engineering",
  "product",
  "marketing",
  "sales",
  "customer",
  "finance",
  "people",
] as const
export type RecommendedDepartment = (typeof RECOMMENDED_DEPARTMENTS)[number]

/**
 * Human-readable label for a department slug. Falls back to a
 * Title-Case-ified version of the slug for departments outside the
 * recommended list (custom org taxonomies).
 */
export function departmentLabel(slug: string): string {
  const labels: Readonly<Record<RecommendedDepartment, string>> = {
    executive: "Executive",
    operations: "Operations",
    engineering: "Engineering",
    product: "Product",
    marketing: "Marketing",
    sales: "Sales",
    customer: "Customer",
    finance: "Finance",
    people: "People",
  }
  if ((labels as Record<string, string>)[slug] !== undefined) {
    return (labels as Record<string, string>)[slug]!
  }
  return slug
    .split("-")
    .map((s) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)))
    .join(" ")
}

export { defineRole } from "./define-role.js"
export type { RoleDefinition, RoleHandle } from "./types.js"

// Resolution / merge — the heart of role composition.
export { resolveRole } from "./resolve.js"
export type {
  ResolveOptions,
  ResolveWarning,
  ResolvedRole,
} from "./resolve.js"

export {
  mergeRoles,
  mergeBodies,
  LIST_FIELDS,
  LOCAL_ONLY_FIELDS,
} from "./merge.js"
export type {
  ListField,
  ListPatch,
  MergeResult,
  MergeWarning,
  RoleChildInput,
} from "./merge.js"

// Source loaders (in-memory builtin shipped here; fs/db live in adapters).
export {
  BuiltinRoleSource,
  builtinSourceFromRecord,
} from "./sources/builtin.js"
export type {
  BuiltinRoleEntry,
  RoleManifestRaw,
  RoleRef,
  RoleSource,
} from "./sources/types.js"
