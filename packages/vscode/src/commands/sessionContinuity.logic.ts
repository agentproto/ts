/**
 * Pure context-continuity helpers for the VS Code extension.
 *
 * These functions operate on the client-side SessionDescriptor mirror and
 * produce display-friendly values for the sessions panel / config lab.
 */

import type { SessionDescriptor } from "../client/types.js"

export interface ContinuityStatusChip {
  label: string
  tooltip: string
  state: "ok" | "warn" | "compact" | "continue-fresh" | "hard-stop" | "unknown"
}

export function canCompactSession(desc: SessionDescriptor): boolean {
  // Best-effort: the explicit compact command sends a /compact prompt.
  // We expose the action for any live agent-cli session.
  return desc.kind === "agent-cli" && (desc.status === "running" || desc.status === "starting")
}

export function canContinueSessionFresh(desc: SessionDescriptor): boolean {
  return (
    desc.kind === "agent-cli" &&
    (desc.status === "running" || desc.status === "starting")
  )
}

export function describeContextPct(desc: SessionDescriptor): string {
  if (desc.contextContinuityHardStopped) return "hard stop"
  if (desc.contextSize === undefined || desc.contextUsed === undefined) return "context unknown"
  const pct = Math.round((desc.contextUsed / desc.contextSize) * 100)
  return `${pct}% context`
}

export function contextContinuityStatusFor(desc: SessionDescriptor): ContinuityStatusChip {
  const policy = desc.contextContinuity
  if (!policy) {
    return {
      label: "continuity: default",
      tooltip: "Context continuity policy not resolved; using safe defaults.",
      state: "unknown",
    }
  }
  if (desc.contextContinuityHardStopped) {
    return {
      label: `continuity: hard stop`,
      tooltip: `Context reached ${policy.hardStopAtPct}%. Continue via fresh continuation.`,
      state: "hard-stop",
    }
  }
  if (desc.contextSize === undefined || desc.contextUsed === undefined) {
    return {
      label: `continuity: ${policy.mode}`,
      tooltip: `Policy: ${policy.mode} · thresholds ${policy.warnAtPct}/${policy.compactAtPct}/${policy.continueFreshAtPct}/${policy.hardStopAtPct}%`,
      state: "unknown",
    }
  }
  const pct = Math.round((desc.contextUsed / desc.contextSize) * 100)
  let state: ContinuityStatusChip["state"] = "ok"
  if (pct >= policy.hardStopAtPct) state = "hard-stop"
  else if (pct >= policy.continueFreshAtPct) state = "continue-fresh"
  else if (pct >= policy.compactAtPct) state = "compact"
  else if (pct >= policy.warnAtPct) state = "warn"

  return {
    label: `context: ${pct}% (${policy.mode})`,
    tooltip: `Context at ${pct}%. Policy: ${policy.mode} · warn ${policy.warnAtPct}% · compact ${policy.compactAtPct}% · continue ${policy.continueFreshAtPct}% · stop ${policy.hardStopAtPct}%`,
    state,
  }
}
