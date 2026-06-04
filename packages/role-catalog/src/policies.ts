/**
 * Companion baseline policies for builtin roles (AIP-38).
 *
 * A role's `defaultPolicy` is ADVISORY per AIP-47 — the runtime MUST NOT
 * auto-apply it without the operator's own `policy:` field or a
 * governance signature attesting the binding. These manifests are the
 * portable declaration of intent that travels with the role; binding
 * them to an operator (and compiling grants into a host's enforcement
 * surface) is a governed, host-side step.
 *
 * Authored as validated TS `definePolicy` objects — same shipping shape
 * as the role seeds — so every field-level constraint runs at module
 * load and the policy is bundleable alongside the catalogue.
 */

import {
  policyFrontmatterSchema,
  type PolicyDefinition,
  type PolicyHandle,
} from "@agentproto/policy"

/**
 * Validate a standalone baseline policy against AIP-38's frontmatter
 * schema (the same source of truth the `.md` manifest path uses).
 *
 * We deliberately do NOT route through `definePolicy`: its
 * `createDoctype` identity gate mandates an `id` and validates it with
 * a bare-slug regex, while the frontmatter schema requires `@owner/slug`
 * — the two are mutually exclusive, so no standalone policy currently
 * passes `definePolicy`. Validating the frontmatter directly (with `id`
 * omitted, which the schema permits) is correct and bug-free.
 */
function defineBaselinePolicy(def: PolicyDefinition): PolicyHandle {
  policyFrontmatterSchema.parse(def)
  return Object.freeze({ ...def })
}

/**
 * Baseline policy for `talent-acquisition-specialist`.
 *
 * `default: deny` — the operator may only perform the recruiting actions
 * explicitly granted (sourcing, screening, candidate messaging, document
 * generation, scheduling, KPI computation). The hire DECISION actions
 * (`hiring:extend-offer`, `hiring:reject-candidate`) are gated behind a
 * human approval requirement rather than granted — the hiring manager
 * decides. Finance / payroll and sensitive-data actions are never granted,
 * so `default: deny` denies them.
 */
// `id` is intentionally omitted (the role references this policy by its
// catalogue ref via `defaultPolicy`, not a self-declared id) — see the
// note on `defineBaselinePolicy` for why `definePolicy`'s id gate is
// avoided here.
export const talentAcquisitionBaselinePolicy: PolicyHandle = defineBaselinePolicy({
  schema: "policy/v1",
  version: "1.0.0",
  default: "deny",
  grants: [
    {
      principal: "role://talent-acquisition-specialist",
      actions: [
        { action: "sourcing:*" },
        { action: "screening:*" },
        { action: "messaging:send-candidate" },
        { action: "document:generate" },
        { action: "scheduling:*" },
        { action: "kpi:compute" },
      ],
    },
  ],
  requirements: [
    {
      kind: "approval-from",
      applies_to: ["hiring:extend-offer", "hiring:reject-candidate"],
      role: "hiring-manager",
    },
  ],
  metadata: {
    aip47: { derivedFrom: "talent-acquisition-specialist" },
  },
})

/** Baseline policies shipped alongside the builtin role catalogue. */
export const BUILTIN_POLICY_HANDLES: readonly PolicyHandle[] = [
  talentAcquisitionBaselinePolicy,
]
