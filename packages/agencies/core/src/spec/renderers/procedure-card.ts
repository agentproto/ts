/**
 * Renderer wrapper for the `agency.procedure-card` canvakit template.
 *
 * Narrative card view of a PROCEDURE.md — overview + step list. Doubles as
 * an in-product help surface and a public preview on agencies.sh registry
 * pages.
 *
 * The template reads the source PROCEDURE.md via `kind:file` data source.
 * The host can pre-compute step state (`done` / `active` / `pending`) and
 * pass the merged shape under `procedure.steps[].stateClass`.
 */

import { z } from "zod"

export const PROCEDURE_CARD_TEMPLATE_ID = "agency.procedure-card" as const

export const PROCEDURE_CARD_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.procedure-card/template.canvakit.html" as const

export const procedureCardVariablesSchema = z.object({
  /** Optional agency name shown in the lead label. */
  agencyName: z.string().optional(),
  /** Workspace-relative path to the PROCEDURE.md being rendered. */
  procedurePath: z.string().min(1),
  /**
   * If rendered inside an active engagement, the slug of the step currently
   * executing. The host fills `step.stateClass = active|done|pending` based
   * on this when projecting the procedure data source. Pass `""` for the
   * static documentation view.
   */
  currentStepId: z.string().default(""),
})
export type ProcedureCardVariables = z.infer<
  typeof procedureCardVariablesSchema
>

export function procedureCardVariables(
  input: ProcedureCardVariables
): Record<string, string> {
  return {
    agencyName: input.agencyName ?? "",
    procedurePath: input.procedurePath,
    currentStepId: input.currentStepId ?? "",
  }
}
