import { z } from "zod"
import {
  envelope,
  isoDurationSchema,
  kebabSlugSchema,
  partyRefStrictSchema,
  timezoneSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `ROUTINE.md` doctype.
 *
 * Schedule **only** — cron, triggers, conditions, escalation. References a
 * PROCEDURE.md by slug for the *what*. (Upgrades agentcompanies/v1's
 * `TASK.recurring: true` boolean with full-fidelity scheduling.)
 *
 * Examples:
 *   - prestation-followup → every 48h, if any ENGAGEMENT.md is suspended on
 *     a counterparty action longer than threshold, runs `nudge-counterparty` procedure.
 *   - monthly-retainer-invoice → 1st of month at 09:00 local; runs
 *     `issue-monthly-retainer-invoice` procedure.
 */

const triggerScheduleSchema = z.object({
  kind: z.literal("schedule"),
  /** Standard 5-field cron (UTC by default unless timezone is set). */
  cronExpression: z.string().min(1),
  timezone: timezoneSchema.optional(),
})

const triggerEventSchema = z.object({
  kind: z.literal("event"),
  /** Event type to react to (free-form for v1). */
  eventType: z.string(),
})

const triggerWebhookSchema = z.object({
  kind: z.literal("webhook"),
  webhookSlug: z.string(),
})

export const routineTriggerSchema = z.discriminatedUnion("kind", [
  triggerScheduleSchema,
  triggerEventSchema,
  triggerWebhookSchema,
])
export type RoutineTrigger = z.infer<typeof routineTriggerSchema>

const routineConditionSchema = z.object({
  /** Free-form condition expression (e.g., "engagementStatus == 'pending_signature'"). */
  expression: z.string().optional(),
  /** Pre-defined condition kinds for common cases. */
  engagementStatus: z.string().optional(),
  /** Maximum runs per period (e.g., max 3 nudges per week). */
  maxPerPeriod: z
    .object({
      count: z.number().positive(),
      period: isoDurationSchema,
    })
    .optional(),
})

const routineEscalationSchema = z.object({
  /** ISO duration: how long before deadline to escalate. */
  ifPendingAfter: isoDurationSchema,
  escalateTo: z.array(partyRefStrictSchema).min(1),
})

export const routineFrontmatterSchema = z.object({
  ...envelope("routine"),

  /** Procedure to run on trigger (PROCEDURE.md slug). */
  runs: kebabSlugSchema,

  trigger: routineTriggerSchema,

  conditions: z.array(routineConditionSchema).default([]),
  escalation: routineEscalationSchema.optional(),

  /** Disabled flag for ad-hoc pausing without deletion. */
  enabled: z.boolean().default(true),
})
export type RoutineFrontmatter = z.infer<typeof routineFrontmatterSchema>

export interface Routine {
  frontmatter: RoutineFrontmatter
  body: string
}

export const ROUTINE_FILENAME = "ROUTINE.md" as const
