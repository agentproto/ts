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
  /** True when a fallback occurred AND the daemon recovered partial context
   *  from its own transcript (daemon events.jsonl). False or absent when no
   *  context was recovered. */
  digestRecovered?: boolean
  kind?: string
  pty?: boolean
  /**
   * Present only when the caller asked for a provider-native terminal
   * (`preferNativeTerminal: true`) and the daemon still landed on ACP
   * resume — names the actual blocker so the client can stop blaming
   * "transcript could not be recovered" for every fallback. Absent from
   * plain restarts and from daemons predating the field.
   */
  nativeResumeDecline?: NativeResumeDecline
}

/** Why a requested native-terminal resume was declined — see the daemon's
 *  `session_restart` agent branch (runtime/src/session-tools.ts). */
export interface NativeResumeDecline {
  reason: "capability-missing" | "no-resume-id" | "transcript-not-found"
  /** Directory the daemon probed for the transcript, when it got that far. */
  probedDir?: string
}

const NATIVE_DECLINE_REASONS = new Set(["capability-missing", "no-resume-id", "transcript-not-found"])

function parseNativeResumeDecline(raw: unknown): NativeResumeDecline | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.reason !== "string" || !NATIVE_DECLINE_REASONS.has(record.reason)) return undefined
  return {
    reason: record.reason as NativeResumeDecline["reason"],
    ...(typeof record.probedDir === "string" ? { probedDir: record.probedDir } : {}),
  }
}

/**
 * The warning body for a restart that asked for a native terminal but came
 * back as something else. Split by actual cause (the old message claimed
 * "the provider transcript could not be recovered" unconditionally):
 * without decline info the daemon never even reported declining a native
 * resume — say the restart didn't get one, not that a transcript is gone.
 */
export function describeNotATerminal(decline: NativeResumeDecline | undefined): string {
  switch (decline?.reason) {
    case "transcript-not-found":
    case "no-resume-id":
      return (
        "the provider transcript was not found" +
        (decline.probedDir ? ` (probed ${decline.probedDir})` : "") +
        " — the daemon fell back to ACP resume."
      )
    case "capability-missing":
      return "this session's adapter row carries no nativeTerminalResume capability — the daemon fell back to ACP resume."
    default:
      return "the restart did not request (or the daemon did not report) a native terminal — it resumed via ACP instead."
  }
}

const RESUME_FALLBACK_MESSAGE_NO_CONTEXT =
  "the prior session had no resumable history — this is a fresh spawn, not a continued conversation"

const RESUME_FALLBACK_MESSAGE_PARTIAL_CONTEXT =
  "the prior session had no resumable history — partial context was recovered from the daemon transcript"

/**
 * True for any terminal-status session — the daemon has no restart guard, so
 * this client-side gate is what prevents restarting a still-alive session
 * (which would silently spawn a duplicate). Includes `session-interrupted`
 * (a daemon-restart ghost): restart-fresh (a NEW id) is always a valid choice
 * for a dead row, even one that ALSO offers resume-in-place — the two are
 * distinct, deliberately-separate actions (see canResumeInPlace in
 * sessionResume.logic.ts), never conflated.
 */
export function canRestart(session: SessionDescriptor): boolean {
  const contextValue = contextValueFor(session)
  return contextValue === "session-done" || contextValue === "session-interrupted"
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

  const decline = parseNativeResumeDecline(record.nativeResumeDecline)
  if (decline) result.nativeResumeDecline = decline

  if (typeof record.resumeFallback === "string" && record.resumeFallback.length > 0) {
    result.resumeFallback = record.resumeFallback
  } else if (record.resumeFallback === true) {
    const digestRecovered = record.digestRecovered === true
    result.resumeFallback = digestRecovered
      ? RESUME_FALLBACK_MESSAGE_PARTIAL_CONTEXT
      : RESUME_FALLBACK_MESSAGE_NO_CONTEXT
    result.digestRecovered = digestRecovered
  }

  return result
}

/**
 * The user-facing toast: names the new id, the resume path, and — when it
 * happened — the pty flip and/or the lost-continuity fallback, so neither
 * is silently hidden from the user.
 */
export function describeRestart(before: SessionDescriptor, after: RestartResult): string {
  // The daemon phrases resumeVia as a full clause ("resumed via ACP"), so
  // prefixing our own "via" stutters into "via resumed via ACP".
  const via = after.resumeVia?.replace(/^resumed\s+via\s+/i, "").trim()
  const viaSuffix = via ? ` via ${via}` : ""
  // Always name the NEW id. Restart carries the label over unchanged, so
  // "restarted X as X" tells the user nothing — the id is the only thing that
  // changed, and it's the row they now have to look at.
  const sentences = [
    `agentproto: restarted ${describeSession(before)} → new session ${after.id}${viaSuffix}.`,
  ]

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
