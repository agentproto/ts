/**
 * Zod shapes for the structured outcome fields (`OutcomeDetail`,
 * `session-outcome.ts`) — shared by every MCP verb that records one
 * (`session_mark_completed`, `session_wrapup_apply`, `agent_kill`).
 */
import { z } from "zod"
import { OUTCOME_BY, OUTCOME_ERROR_KINDS, STOP_OUTCOME_VERDICTS } from "./session-outcome.js"

export const outcomeDetailShape = {
  reason: z.string().optional().describe("Free text: why the session completed / failed / was abandoned (recorded on the outcome as `reason`)."),
  question: z.string().optional().describe("For a needs-input verdict: the question the session is waiting on."),
  errorKind: z.enum(OUTCOME_ERROR_KINDS).optional().describe("Why it failed: quota | upstream | timeout | crash | logic | none."),
  nextStep: z.string().optional().describe("What should happen next — the remaining work, or how to retry."),
  by: z.enum(OUTCOME_BY).optional().describe("Who states this outcome: steward-rules | jev | agent | user."),
}

/** `agent_kill`'s nested `outcome`: the verdict plus the detail fields. */
export const stopOutcomeSchema = z
  .object({
    verdict: z.enum(STOP_OUTCOME_VERDICTS).optional().describe("done | failed | abandoned | needs-input."),
    note: z.string().optional(),
    judgedBy: z.string().optional(),
    ...outcomeDetailShape,
  })
  .strict()
