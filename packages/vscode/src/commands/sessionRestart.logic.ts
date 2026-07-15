/**
 * Pure logic for reviving a killed/exited/errored session. No `vscode`
 * import so this is directly unit-testable; sessionRestart.ts's command
 * calls into these.
 *
 * `session_restart` (runtime/src/session-tools.ts) is MCP-only and has NO
 * status guard server-side — restarting a still-alive session silently
 * spawns a duplicate. `canRestart` is therefore the client-side gate that
 * makes the command safe, and restart always mints a brand-new session id
 * (continuity is via `claude --resume` / adapter resume, never id reuse),
 * so callers must reveal/open the NEW id, not the one they restarted.
 */

import type { SessionDescriptor } from "../client/types.js"
import { contextValueFor } from "../views/sessionsTree.logic.js"
import { describeSession } from "./sessionActions.logic.js"

/** Narrowed view of the `session_restart` MCP result the UI actually needs. */
export interface RestartResult {
  id: string
  label?: string
  resumedFrom?: string
  resumeVia?: string
  /**
   * Present only when the daemon fell back to a fresh spawn (the resume id
   * it tried was rejected, or the prior session never got one) — set to a
   * human-readable reason since the wire only carries a boolean flag.
   */
  resumeFallback?: string
  kind?: string
  pty?: boolean
}

const RESUME_FALLBACK_MESSAGE =
  "the prior session had no resumable history — this is a fresh spawn, not a continued conversation"

/**
 * True only for terminal-status sessions — the daemon has no restart guard,
 * so this client-side gate is what prevents restarting a still-alive
 * session (which would silently spawn a duplicate).
 */
export function canRestart(session: SessionDescriptor): boolean {
  return contextValueFor(session) === "session-done"
}

/**
 * Narrow the MCP tool's untyped result into a RestartResult. Tolerates a
 * shape it doesn't recognise by returning undefined rather than throwing —
 * the caller reports a plain error in that case.
 */
export function parseRestartResult(raw: unknown): RestartResult | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== "string") return undefined

  const result: RestartResult = { id: record.id }
  if (typeof record.label === "string") result.label = record.label
  if (typeof record.resumedFrom === "string") result.resumedFrom = record.resumedFrom
  if (typeof record.resumeVia === "string") result.resumeVia = record.resumeVia
  if (typeof record.kind === "string") result.kind = record.kind
  if (typeof record.pty === "boolean") result.pty = record.pty

  if (typeof record.resumeFallback === "string" && record.resumeFallback.length > 0) {
    result.resumeFallback = record.resumeFallback
  } else if (record.resumeFallback === true) {
    result.resumeFallback = RESUME_FALLBACK_MESSAGE
  }

  return result
}

/**
 * The user-facing toast: names the new id, the resume path, and — when it
 * happened — the pty flip and/or the lost-continuity fallback, so neither
 * is silently hidden from the user.
 */
export function describeRestart(before: SessionDescriptor, after: RestartResult): string {
  const newLabel = after.label ?? after.id
  const viaSuffix = after.resumeVia ? ` via ${after.resumeVia}` : ""
  const sentences = [`agentproto: restarted ${describeSession(before)} as ${newLabel}${viaSuffix}.`]

  if (before.kind === "agent-cli" && after.pty === true) {
    sentences.push(
      "Resumed as a terminal session (pty-native) — its transcript is raw output, not a conversation.",
    )
  }

  if (after.resumeFallback) {
    sentences.push(`Continuity was not achieved: ${after.resumeFallback}.`)
  }

  return sentences.join(" ")
}
