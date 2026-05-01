import { z } from "zod"
import {
  envelope,
  isoDurationSchema,
  kebabSlugSchema,
  partyRefSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `PROCEDURE.md` doctype.
 *
 * Vendor-neutral playbook. Step-by-step "how to do X": triggers, required skills,
 * autonomy policy, branching steps with expected outputs.
 *
 * A Mastra workflow.ts is *one possible implementation* of a PROCEDURE.md;
 * other orchestrators (Temporal, n8n, manual humans) can read and follow the
 * same procedure without our infrastructure.
 *
 * Relationship to ROUTINE.md: ROUTINE.md says "when" (cron, triggers); PROCEDURE.md
 * says "what" (steps).
 */

export const procedureTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("service"), service: kebabSlugSchema }),
  z.object({ kind: z.literal("routine"), routine: kebabSlugSchema }),
  z.object({ kind: z.literal("manual"), description: z.string().optional() }),
  z.object({ kind: z.literal("event"), eventType: z.string() }),
])
export type ProcedureTrigger = z.infer<typeof procedureTriggerSchema>

/**
 * A step is identified by a unique id within the procedure. Steps run in
 * declared order unless a `branch` redirects.
 */
const stepBaseSchema = z.object({
  id: kebabSlugSchema,
  description: z.string().optional(),
  /** Skill required to execute this step (refs companies.sh SKILL.md). */
  requiredSkill: z.string().optional(),
  /** What this step produces (free-form descriptor). */
  output: z.string().optional(),
})

/** A simple step without branching. */
export const procedureSimpleStepSchema = stepBaseSchema.extend({
  branch: z.never().optional(),
})

/** A branching step — picks which step (by id) to run next based on conditions. */
export const procedureBranchStepSchema = stepBaseSchema.extend({
  branch: z
    .array(
      z.object({
        if: z.string().optional(), // condition expression (free-form for v1)
        else: z.boolean().optional(),
        action: z.string(), // "proceed_repair", "requestSignaturesTool", "advance_to_step:<id>", etc.
      })
    )
    .min(1),
})

export const procedureStepSchema = z.union([
  procedureSimpleStepSchema,
  procedureBranchStepSchema,
])
export type ProcedureStep = z.infer<typeof procedureStepSchema>

export const procedureFrontmatterSchema = z.object({
  ...envelope("procedure"),

  /** What invokes this procedure. */
  triggers: z.array(procedureTriggerSchema).default([]),

  /** Skills required across the whole procedure (union of step requirements). */
  requiredSkills: z.array(z.string()).default([]),

  /** Estimated total duration (ISO-8601 duration). */
  estimatedDuration: isoDurationSchema.optional(),

  /**
   * Slug of a POLICY.md (agentgovernance/v1) that governs autonomy for this
   * procedure. Steps may individually require signatures via the policy.
   */
  autonomyPolicy: kebabSlugSchema.optional(),

  /** Steps in declared order. */
  steps: z.array(procedureStepSchema).min(1),

  /**
   * Default approvers when a step gates on signature without an explicit
   * policy override (typically refs governance.requiredSignatures).
   */
  defaultApprovers: z.array(partyRefSchema).default([]),
})
export type ProcedureFrontmatter = z.infer<typeof procedureFrontmatterSchema>

export interface Procedure {
  frontmatter: ProcedureFrontmatter
  body: string
}

export const PROCEDURE_FILENAME = "PROCEDURE.md" as const
