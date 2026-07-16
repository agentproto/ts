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

/**
 * Why a prompt POST was refused.
 *
 * `busy` is NOT a failure the user should ever see as an error: the daemon
 * allows one turn at a time per session and rejects a prompt sent mid-turn
 * with 409 (`validateAgentTurn`, sessions.ts — "is mid-turn — wait for it to
 * finish or cancel"). Despite its name `enqueuePrompt` does not queue; only
 * `interrupt: true` gets through. Typing while the agent works is completely
 * normal, so the panel holds the message and sends it when the turn ends —
 * this classification is what tells it to queue instead of shouting.
 */
export type SendFailureKind = "busy" | "not-alive" | "other"

export function classifySendFailure(message: string): SendFailureKind {
  // Match the daemon's own wording/status rather than a substring of the URL,
  // which carries a session id and would false-positive on any 409.
  if (/\b409\b/.test(message) && /mid-turn/i.test(message)) return "busy"
  if (/session_not_alive/i.test(message) || /not alive/i.test(message)) return "not-alive"
  return "other"
}

/** Human title for the error banner — the one-line "what happened". */
export function sendFailureTitle(kind: SendFailureKind): string {
  switch (kind) {
    case "busy":
      return "Agent is mid-turn"
    case "not-alive":
      return "Session is no longer running"
    case "other":
      return "Send failed"
  }
}

/**
 * Filename for a tool value opened in an editor — e.g. `Bash output (a1b2c3).log`.
 *
 * This is the tab title, so it has to survive real tool names: agentproto's
 * carry their target (`read: /Volumes/…/index.ts`), which is full of path
 * separators and would otherwise fabricate URI path segments. Anything not
 * filename-safe collapses to `-`, and the name is capped — untruncated, it
 * renders as an unreadable tab.
 *
 * The segment-id suffix disambiguates two calls to the same tool in one turn
 * AND keeps the URI stable, so re-opening the same value reveals its existing
 * tab instead of stacking duplicates.
 */
export function toolIoDocumentName(
  toolName: string | undefined,
  field: "input" | "output",
  segmentId: string,
  json: boolean,
): string {
  const safe =
    (toolName ?? "tool")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "tool"
  const short = segmentId.replace(/\W+/g, "").slice(-6) || "value"
  return `${safe} ${field} (${short}).${json ? "json" : "log"}`
}
