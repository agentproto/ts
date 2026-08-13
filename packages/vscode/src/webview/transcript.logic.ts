/**
 * Pure helper logic for the transcript webview. No `vscode` import so it can
 * be unit-tested under plain vitest and reused by the webview script.
 */

import { sessionDisplayName } from "../client/sessionName.js"
import type { SessionDescriptor, SessionStreamLine, SessionWatcherInfo } from "../client/types.js"
import { formatDuration } from "../views/sessionsTree.logic.js"

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

// `statusChip()` used to live here, emitting "busy" / "running". It was dead
// code: the chip actually on screen is computeStatusChip() inside
// transcriptPanel.ts's webview script, which has emitted working / waiting /
// stalled since the stall work landed. Nothing but its own test still called
// this one — so it survived purely as a second, contradictory answer to "what
// state is this session in", which is the exact confusion this pass exists to
// remove. That vocabulary now has one home: SessionActivity, in
// views/sessionsTree.logic.ts.

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

/** The transcript tab/header title. Thin alias over the shared
 *  `sessionDisplayName` (SPEC-3 FIX D) so the tab, the tree row, and the
 *  in-panel header all resolve a name the same way. */
export function formatTitle(
  session: Pick<SessionDescriptor, "label" | "title" | "id" | "adapterSlug" | "kind" | "renamedByUser">,
): string {
  return sessionDisplayName(session)
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
export type SendFailureKind = "busy" | "not-alive" | "timeout" | "other"

export function classifySendFailure(message: string): SendFailureKind {
  // Match the daemon's own wording/status rather than a substring of the URL,
  // which carries a session id and would false-positive on any 409.
  if (/\b409\b/.test(message) && /mid-turn/i.test(message)) return "busy"
  if (/session_not_alive/i.test(message) || /not alive/i.test(message)) return "not-alive"
  // AbortSignal.timeout throws a TimeoutError DOMException ("The operation was
  // aborted due to timeout"); a plain AbortController abort says "This
  // operation was aborted". Both surface here as the client giving up on a
  // send the daemon may still complete — distinct from a real refusal, and
  // worth one automatic retry (see TranscriptPanelController.onSend). Checked
  // AFTER the 409/not-alive arms so a real daemon answer never misclassifies.
  if (/abort|timed?[ -]?out/i.test(message)) return "timeout"
  return "other"
}

/** Human title for the error banner — the one-line "what happened". */
export function sendFailureTitle(kind: SendFailureKind): string {
  switch (kind) {
    case "busy":
      return "Agent is mid-turn"
    case "not-alive":
      return "Session is no longer running"
    case "timeout":
      return "Session is slow to respond"
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

/**
 * Describe a user-prompt turn's provenance (`PresentedTurn.promptSource`,
 * carried from the daemon's `user-prompt` record `source`) for the turn
 * header badge. The daemon stamps `agent:<sessionId>` when another session
 * injected the prompt (a supervisor's `agent_prompt`, a parent's spawn
 * prompt); an unattributed human call has NO source at all — the caller
 * renders nothing in that case, so this helper is only consulted with a
 * non-empty string.
 *
 * Returns `undefined` for an empty/missing source (defensive — mirrors the
 * human case). For the known `agent:<id>` shape the badge is the compact
 * `⇄ from <shortId>` and the tooltip names the mechanism; ANY OTHER
 * non-empty source (a future provenance vocabulary the panel doesn't know
 * yet) still earns a badge, showing the raw string rather than dropping the
 * attribution on the floor.
 *
 * `shortId` keeps the full id's tail (session ids are `sess_<hex>` — the
 * tail is the discriminating part, matching `shortSessionId` in
 * transcriptPanel.ts / client/sessionName.ts); the FULL id rides the
 * tooltip so the badge never has to choose between compactness and
 * precision.
 */
export function describePromptSource(
  source: string | undefined,
): { label: string; tooltip: string } | undefined {
  if (!source) return undefined
  const agentMatch = /^agent:(.+)$/.exec(source)
  if (agentMatch) {
    const id = agentMatch[1]!
    const shortId = id.length > 8 ? id.slice(-6) : id
    return {
      label: `⇄ from ${shortId}`,
      tooltip: `Injected by session ${id} via agent_prompt`,
    }
  }
  return {
    label: `⇄ ${source}`,
    tooltip: `Prompt source: ${source}`,
  }
}

/** Human phrase for what a wait is blocking on — mirrors `session_monitor`'s
 *  `event` vocabulary (`SessionWaitEvent` in @agentproto/runtime). Falls back
 *  to the raw event string for anything unrecognized (forward-compatible with
 *  a daemon that adds a new wait kind before the client updates). */
const WAIT_EVENT_PHRASES: Readonly<Record<string, string>> = {
  "turn-end": "until turn-end",
  "awaiting-input": "until it asks for input",
  exited: "until it exits",
  any: "for any change",
}

/** "until turn-end, 2h timeout" — the wait condition a watcher chip/banner
 *  shows, from a single {@link SessionWatcherInfo}. */
export function describeWaitCondition(detail: SessionWatcherInfo): string {
  const phrase = WAIT_EVENT_PHRASES[detail.event] ?? `until ${detail.event}`
  return typeof detail.timeoutMs === "number" ? `${phrase}, ${formatDuration(detail.timeoutMs)} timeout` : phrase
}

/** A watcher's display identity — its label when known, else its (short)
 *  session id, else undefined for a fully anonymous CLI/HTTP waiter. */
export function watcherIdentity(detail: SessionWatcherInfo): string | undefined {
  return detail.watcherLabel ?? detail.watcherSessionId
}

/**
 * Decide the cross-session info banner for a watcher-count change between two
 * successive session descriptors (`onSessionUpdate`). The daemon's
 * `session:watcher-attached`/`-detached` bus events do NOT reach the panel
 * (they never flow through the structured events.jsonl record feed), so the
 * panel diffs the ephemeral `watchers` counter (and now `watcherDetails`,
 * #session-visibility) it already receives.
 *
 * Returns the banner text to show, or `undefined` when the change isn't worth
 * a ping: an increase announces the NEW watcher — named with its wait
 * condition when `nextDetails` carries identity (`"<label> — until
 * turn-end"`), bare-count otherwise (an anonymous CLI/HTTP waiter, or the
 * caller not passing details); a decrease only earns a banner when it reaches
 * ZERO (the last watcher leaving is the notable transition — one of several
 * detaching is noise), named from `prevDetails` when exactly one watcher was
 * attached before the drop. No change, a 0→0, or a partial decrease all
 * return `undefined`.
 */
export function watcherBannerFor(
  prev: number | undefined,
  next: number | undefined,
  opts: { prevDetails?: readonly SessionWatcherInfo[]; nextDetails?: readonly SessionWatcherInfo[] } = {},
): string | undefined {
  const before = prev ?? 0
  const after = next ?? 0
  if (after > before) {
    const newest = opts.nextDetails?.at(-1)
    const who = newest ? watcherIdentity(newest) : undefined
    if (who) {
      const suffix = after > 1 ? ` (${after} waiting total)` : ""
      return `A watcher attached — ${who} — ${describeWaitCondition(newest!)}${suffix}`
    }
    return `A watcher attached — ${after} waiting on this session`
  }
  if (after < before && after === 0) {
    const departing = before === 1 ? opts.prevDetails?.at(0) : undefined
    const who = departing ? watcherIdentity(departing) : undefined
    return who ? `Watcher detached — ${who}` : "Watcher detached"
  }
  return undefined
}

