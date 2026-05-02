/**
 * AIP-7 POLICY.md — `definePolicy` constructor + `policyFromManifest`
 * markdown-authored entry. Built on `@agentproto/define-doctype`.
 *
 * Policies are the AIP-7 doctype that declares "what an autonomous
 * actor may do without further approval, and what threshold of
 * signatures it needs when a cap is exceeded". Authoring path A
 * (`definePolicy({...})`) covers the in-process / TS-authored case;
 * authoring path B (`policyFromManifest(parsed)`) covers the
 * filesystem-authored case where the policy ships as a `POLICY.md`
 * under a workspace's `policies/<slug>/` folder.
 *
 * Both paths land in the same `createDoctype` pipeline as `defineTool`
 * and `defineDriver`: identity is regex-validated, the produced handle
 * is `Object.freeze`-d, errors carry the canonical `definePolicy
 * (AIP-7): …` prefix, and spec-specific invariants run after the
 * shared ones.
 *
 * Departs from the AIP-14/AIP-30 default shape on three axes — which
 * is what makes this a useful test of the meta-factory's flexibility:
 *   - identity field is `slug`, not `id`
 *   - identity pattern is stricter (no dots, no underscores): `^[a-z0-9][a-z0-9-]*$`
 *   - `description` is OPTIONAL on the doctype; the LLM-facing copy
 *     lives in `name`. We skip the description length check entirely.
 */

import { createDoctype } from "@agentproto/define-doctype"
import matter from "gray-matter"
import {
  policyFrontmatterSchema,
  type PolicyAppliesTo,
  type PolicyCap,
  type PolicyEscalation,
  type PolicyFrontmatter,
  type PolicyThreshold,
  type RequiredSigner,
} from "../spec/doctypes/policy.js"

const POLICY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Input to `definePolicy`. Mirrors `PolicyFrontmatter` minus the
 * spec-fixed `schema` and `doctype` fields (which the runtime fills).
 * Every other field is preserved verbatim.
 */
export interface PolicyDefinition {
  slug: string
  name: string
  description?: string
  appliesTo?: readonly PolicyAppliesTo[]
  caps?: readonly PolicyCap[]
  threshold?: PolicyThreshold
  /** Required when `threshold === "weighted_threshold"`. */
  requiredWeight?: number
  requiredSignatures?: readonly RequiredSigner[]
  /** ISO-8601 duration. */
  deadline?: string
  escalation?: PolicyEscalation
  metadata?: Record<string, unknown>
}

/**
 * The host-registrable handle returned by `definePolicy`. Frozen,
 * with array/object fields shallow-frozen to lock the wire shape.
 */
export interface PolicyHandle {
  readonly schema: "agentgovernance/v1"
  readonly doctype: "policy"
  readonly slug: string
  readonly name: string
  readonly description?: string
  readonly appliesTo: readonly PolicyAppliesTo[]
  readonly caps: readonly PolicyCap[]
  readonly threshold: PolicyThreshold
  readonly requiredWeight?: number
  readonly requiredSignatures: readonly RequiredSigner[]
  readonly deadline?: string
  readonly escalation?: PolicyEscalation
  readonly metadata: Record<string, unknown>
}

/**
 * AIP-7 reference implementation of `definePolicy`. Goes through
 * `createDoctype` so the cross-AIP invariants (slug pattern check,
 * top-level freeze, `definePolicy (AIP-7): …` error prefix) run
 * uniformly with `defineTool` / `defineDriver`.
 *
 * Spec-specific validation enforced here:
 *   - `name` must be 1+ chars (zod-equivalent of `.min(1)`)
 *   - `threshold === "weighted_threshold"` requires `requiredWeight`
 *     to be set (matches the `.refine()` on the manifest schema).
 */
export const definePolicy = createDoctype<PolicyDefinition, PolicyHandle>({
  aip: 7,
  name: "policy",
  readIdentity: (def) => def.slug,
  idPattern: POLICY_SLUG_PATTERN,
  // POLICY.md treats `description` as optional and uses `name` as the
  // human-readable label. Skip the cross-AIP description check; let
  // spec-7 validate `name` itself in `validate()`.
  readDescription: false,
  validate(def) {
    if (typeof def.name !== "string" || def.name.length === 0) {
      throw new Error(
        `definePolicy (AIP-7): slug='${def.slug}' name must be a non-empty string`,
      )
    }
    if (
      def.threshold === "weighted_threshold" &&
      typeof def.requiredWeight !== "number"
    ) {
      throw new Error(
        `definePolicy (AIP-7): slug='${def.slug}' threshold='weighted_threshold' requires requiredWeight to be set`,
      )
    }
  },
  build(def) {
    return {
      schema: "agentgovernance/v1",
      doctype: "policy",
      slug: def.slug,
      name: def.name,
      description: def.description,
      appliesTo: Object.freeze([...(def.appliesTo ?? [])]),
      caps: Object.freeze([...(def.caps ?? [])]),
      threshold: def.threshold ?? "single",
      requiredWeight: def.requiredWeight,
      requiredSignatures: Object.freeze([...(def.requiredSignatures ?? [])]),
      deadline: def.deadline,
      escalation: def.escalation,
      metadata: Object.freeze({ ...(def.metadata ?? {}) }),
    }
  },
})

/**
 * Parsed POLICY.md manifest — frontmatter validated against the
 * AIP-7 zod schema, body kept as-is for downstream consumers.
 */
export interface PolicyManifest {
  frontmatter: PolicyFrontmatter
  body: string
}

/**
 * Parse a POLICY.md source string. Throws on missing or schema-invalid
 * frontmatter.
 */
export function parsePolicyManifest(source: string): PolicyManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parsePolicyManifest: missing or empty frontmatter")
  }
  const result = policyFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parsePolicyManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

/**
 * Build a {@link PolicyHandle} from a parsed `POLICY.md` manifest.
 * Same single-source-of-truth principle as `toolFromManifest` /
 * `driverFromManifest`: the frontmatter is the source of truth for
 * metadata; the handle ends up in `definePolicy` so AIP-7 invariants
 * (and the meta-factory's shared invariants) run uniformly.
 */
export function policyFromManifest(manifest: PolicyManifest): PolicyHandle {
  const fm = manifest.frontmatter
  return definePolicy({
    slug: fm.slug,
    name: fm.name,
    description: fm.description,
    appliesTo: fm.appliesTo,
    caps: fm.caps,
    threshold: fm.threshold,
    requiredWeight: fm.requiredWeight,
    requiredSignatures: fm.requiredSignatures,
    deadline: fm.deadline,
    escalation: fm.escalation,
    metadata: fm.metadata,
  })
}

export { POLICY_SLUG_PATTERN }
