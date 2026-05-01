import { z } from "zod"
import { signingMethodSchema } from "./signature.js"
import { actorKindSchema } from "./audit-event.js"

/**
 * agentgovernance/v1 — POLICY.md doctype.
 *
 * Declarative autonomy rule. Frontmatter declares scope (who/what the policy
 * applies to), constraints (caps, thresholds), and what's required when those
 * thresholds are exceeded (signatures, escalation). Body is human-readable
 * narrative + edge cases.
 *
 * File location: `<scope>/policies/<slug>/POLICY.md` (e.g.,
 * `policies/invoice-cap-500eur/POLICY.md`).
 *
 * Example frontmatter:
 *
 * ```yaml
 * schema: agentgovernance/v1
 * doctype: policy
 * slug: invoice-cap-500eur
 * name: Invoice cap 500 EUR
 * appliesTo:
 *   - actorKind: operator
 *     actionType: agency.issue_invoice
 * caps:
 *   - field: amount
 *     max: 500
 *     currency: EUR
 * threshold: single
 * requiredSignatures:
 *   - signer: operator:founder
 *     method: typed_name
 * deadline: PT24H
 * escalation:
 *   leadTime: PT2H
 *   escalateTo: [operator:cofounder]
 * ```
 */

export const policyAppliesToSchema = z.object({
  /** Restrict by actor kind (e.g., only operators, only agents). */
  actorKind: actorKindSchema.optional(),
  /** Restrict to a specific actor slug. */
  actorId: z.string().optional(),
  /** Restrict to a team. */
  teamId: z.string().optional(),
  /**
   * Restrict to an action type, e.g., `agency.issue_invoice`,
   * `agency.send_agreement`, `governance.policy_override`.
   */
  actionType: z.string().optional(),
})
export type PolicyAppliesTo = z.infer<typeof policyAppliesToSchema>

export const policyCapSchema = z.object({
  field: z.string(), // e.g., "amount"
  max: z.number().optional(),
  min: z.number().optional(),
  currency: z.string().length(3).optional(), // ISO 4217 (e.g., "EUR")
})
export type PolicyCap = z.infer<typeof policyCapSchema>

/** How collected signatures are evaluated. */
export const POLICY_THRESHOLD = [
  "auto", // tool may proceed without signatures (logged)
  "single", // any one of requiredSignatures suffices
  "all_of", // every requiredSignatures entry must sign
  "any_of", // any one of requiredSignatures suffices (alias of single, kept for clarity)
  "weighted_threshold", // sum of weights of collected signatures must reach requiredWeight
] as const
export const policyThresholdSchema = z.enum(POLICY_THRESHOLD)
export type PolicyThreshold = z.infer<typeof policyThresholdSchema>

export const requiredSignerSchema = z.object({
  /** Canonical "<kind>:<slug>"; or "<kind>:*" to mean "any signer of this kind". */
  signer: z
    .string()
    .regex(
      /^(operator|user|counterparty|agent|external):([a-z0-9][a-z0-9-]*|\*)$/,
      {
        message: "Expected '<kind>:<slug>' or '<kind>:*'",
      }
    ),
  method: signingMethodSchema,
  /** For weighted_threshold; ignored otherwise. */
  weight: z.number().min(0).optional(),
})
export type RequiredSigner = z.infer<typeof requiredSignerSchema>

export const policyEscalationSchema = z.object({
  /** ISO-8601 duration; how long before deadline to escalate. */
  leadTime: z
    .string()
    .regex(/^P/, { message: "Expected ISO-8601 duration starting with 'P'" }),
  /** Canonical signer ids who get escalated to. */
  escalateTo: z.array(z.string()).min(1),
})
export type PolicyEscalation = z.infer<typeof policyEscalationSchema>

export const policyFrontmatterSchema = z
  .object({
    schema: z.literal("agentgovernance/v1"),
    doctype: z.literal("policy"),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, { message: "Expected lowercase slug" }),
    name: z.string().min(1),
    description: z.string().optional(),

    appliesTo: z.array(policyAppliesToSchema).default([]),
    caps: z.array(policyCapSchema).default([]),
    threshold: policyThresholdSchema.default("single"),
    /** Required when threshold === "weighted_threshold"; sum of collected signature weights must >= this. */
    requiredWeight: z.number().min(0).optional(),
    requiredSignatures: z.array(requiredSignerSchema).default([]),

    /** ISO-8601 duration. The whole signature-collection process must complete within this. */
    deadline: z.string().regex(/^P/).optional(),
    escalation: policyEscalationSchema.optional(),

    /** Vendor extensions under metadata.<vendor>.* */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    p =>
      p.threshold !== "weighted_threshold" ||
      typeof p.requiredWeight === "number",
    { message: "threshold='weighted_threshold' requires requiredWeight" }
  )
export type PolicyFrontmatter = z.infer<typeof policyFrontmatterSchema>

/**
 * Parsed POLICY.md = frontmatter + markdown body.
 * The body is informational (humans + agents can read it); it is NOT used by
 * the policy engine for decisions.
 */
export interface Policy {
  frontmatter: PolicyFrontmatter
  body: string
}

/** Convenience filename helper. */
export function policyDirname(slug: string): string {
  return `policies/${slug}`
}
