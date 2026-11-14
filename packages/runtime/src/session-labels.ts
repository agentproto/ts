/**
 * `session_labels`: a narrow read that turns session ids into the name an app
 * UI can show. It exists so an app can list this one tool in its `ui.tools`
 * instead of `session_list`, which would hand every agent that can reach
 * `app_tool_call` the whole session list (cwd, prompts, models, ...).
 *
 * The row shape is the whole contract: nothing but `id`, `label`,
 * `operatorLabel`, `adapter` and `state` ever leaves this module. The derived
 * `title` is deliberately not used: it is the first sentence of the caller's
 * prompt.
 */

import { z } from "zod"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

export const SESSION_LABELS_MAX_IDS = 100
export const SESSION_LABELS_MAX_ID_LENGTH = 256

export const sessionLabelsInputShape = {
  ids: z
    .array(z.string().min(1).max(SESSION_LABELS_MAX_ID_LENGTH))
    .min(1)
    .max(SESSION_LABELS_MAX_IDS)
    .describe(
      `1 to ${SESSION_LABELS_MAX_IDS} session ids. A bare id, or the \`session:<fp>:<sessionId>\` form (the last segment is used).`,
    ),
}

const sessionLabelsInputSchema = z.object(sessionLabelsInputShape).strict()

export type SessionLabelState = "live" | "idle" | "exited" | "unknown"

export interface SessionLabelRow {
  id: string
  label?: string
  operatorLabel?: string
  adapter?: string
  state?: SessionLabelState
}

export class SessionLabelsInputError extends Error {}

function bareSessionId(id: string): string {
  if (!id.startsWith("session:")) return id
  return id.slice(id.lastIndexOf(":") + 1)
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function stateOf(desc: Pick<SessionDescriptor, "status" | "currentPhase">): SessionLabelState {
  switch (desc.status) {
    case "exited":
    case "killed":
    case "error":
      return "exited"
    case "starting":
    case "running":
      return desc.currentPhase === "idle" || desc.currentPhase === "awaiting-input" ? "idle" : "live"
    default:
      return "unknown"
  }
}

/**
 * Validates `ids` itself: `app_tool_call` reaches this tool's handler directly
 * (no zod parse), so the registered schema alone is not a guard.
 */
export function resolveSessionLabels(
  registry: Pick<SessionsRegistry, "get">,
  ids: unknown,
): { labels: SessionLabelRow[] } {
  const parsed = sessionLabelsInputSchema.safeParse({ ids })
  if (!parsed.success) {
    throw new SessionLabelsInputError(
      `session_labels: \`ids\` must be 1 to ${SESSION_LABELS_MAX_IDS} strings of 1 to ${SESSION_LABELS_MAX_ID_LENGTH} characters.`,
    )
  }
  const labels = parsed.data.ids.map((id): SessionLabelRow => {
    const bare = bareSessionId(id)
    const desc = bare ? registry.get(bare) : undefined
    if (!desc) return { id }
    const label = nonEmpty(desc.label)
    const operatorLabel = nonEmpty(desc.operatorLabel)
    const adapter = nonEmpty(desc.adapterSlug)
    return {
      id,
      ...(label ? { label } : {}),
      ...(operatorLabel ? { operatorLabel } : {}),
      ...(adapter ? { adapter } : {}),
      state: stateOf(desc),
    }
  })
  return { labels }
}
