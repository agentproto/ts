/**
 * Pure helper logic for the transcript webview. No `vscode` import so it can
 * be unit-tested under plain vitest and reused by the webview script.
 */

import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"

export interface TranscriptModel {
  sessionId: string
  sessionLabel: string
  adapter?: string
  model?: string
  status: SessionDescriptor["status"]
  busy: boolean
  awaitingInput: boolean
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  exited: boolean
  /** Live output lines appended since the initial export. */
  lines: SessionStreamLine[]
}

export function createTranscriptModel(session: SessionDescriptor): TranscriptModel {
  return {
    sessionId: session.id,
    sessionLabel: session.label ?? session.id,
    adapter: session.adapterSlug,
    model: session.model,
    status: session.status,
    busy: session.busy ?? false,
    awaitingInput: session.awaitingInput ?? false,
    costUsd: session.costUsd,
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    exited: isExited(session.status),
    lines: [],
  }
}

export function applySessionUpdate(
  model: TranscriptModel,
  session: SessionDescriptor,
): TranscriptModel {
  return {
    ...model,
    sessionId: session.id,
    sessionLabel: session.label ?? session.id,
    adapter: session.adapterSlug,
    model: session.model,
    status: session.status,
    busy: session.busy ?? false,
    awaitingInput: session.awaitingInput ?? false,
    costUsd: session.costUsd,
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    exited: isExited(session.status),
  }
}

export function appendStreamLines(
  model: TranscriptModel,
  lines: SessionStreamLine[],
): TranscriptModel {
  if (lines.length === 0) return model
  return { ...model, lines: [...model.lines, ...lines] }
}

export function isExited(status: SessionDescriptor["status"]): boolean {
  return status === "exited" || status === "killed" || status === "error"
}

/**
 * Live status chip label. Priority:
 *   exited/killed/error → "exited"
 *   busy → "busy"
 *   awaitingInput → "awaiting-input"
 *   running → "running"
 *   otherwise the raw status
 */
export function statusChip(
  session: Pick<SessionDescriptor, "status" | "busy" | "awaitingInput">,
): string {
  if (isExited(session.status)) return "exited"
  if (session.busy) return "busy"
  if (session.awaitingInput) return "awaiting-input"
  if (session.status === "running") return "running"
  return session.status
}

export function formatCostLine(
  session: Pick<SessionDescriptor, "costUsd" | "tokensIn" | "tokensOut">,
): string {
  const parts: string[] = []
  if (typeof session.costUsd === "number") {
    parts.push(`$${session.costUsd.toFixed(4)}`)
  }
  const tokens: string[] = []
  if (typeof session.tokensIn === "number") tokens.push(`in ${session.tokensIn}`)
  if (typeof session.tokensOut === "number") tokens.push(`out ${session.tokensOut}`)
  if (tokens.length > 0) parts.push(tokens.join(" · "))
  return parts.join(" · ") || "—"
}

export function formatTitle(session: Pick<SessionDescriptor, "label" | "id">): string {
  return session.label ?? session.id
}

export function formatSubtitle(session: Pick<SessionDescriptor, "adapterSlug" | "model">): string {
  const parts: string[] = []
  if (session.adapterSlug) parts.push(session.adapterSlug)
  if (session.model) parts.push(session.model)
  return parts.join(" · ") || ""
}
