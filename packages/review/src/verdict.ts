/**
 * Verdict fan-in: how lane results fold into `pass | block | incomplete`,
 * and how an agent lane's findings become a lane status under `blockOn`.
 *
 * The one rule that matters: nothing that didn't run can pass. A blocking
 * lane that timed out or was skipped makes the verdict `incomplete` — unless
 * another blocking lane definitively failed, in which case the verdict is
 * `block` (a known failure is the stronger, more useful answer).
 * Advisory (non-blocking) lanes are recorded but never move the verdict.
 */

import type { Finding, LaneResult, LaneStatus, Quorum, Severity, Verdict } from "./types.js"

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 }

/** `true` when `severity` is at or above the `blockOn` threshold. */
export function meetsSeverity(severity: Severity, blockOn: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[blockOn]
}

/** An agent lane's status from its findings: `fail` iff any finding is at or
 *  above `blockOn`. Findings below the threshold ride along as advisory. */
export function agentLaneStatus(findings: readonly Finding[], blockOn: Severity): Extract<LaneStatus, "pass" | "fail"> {
  return findings.some((f) => meetsSeverity(f.severity, blockOn)) ? "fail" : "pass"
}

/** Fold lane results into a verdict under `quorum`. */
export function foldVerdict(lanes: readonly LaneResult[], quorum: Quorum = "all-blocking-pass"): Verdict {
  if (quorum !== "all-blocking-pass") {
    // Exhaustiveness guard for a future quorum — an unknown rule must not
    // default to a pass.
    return "incomplete"
  }
  const blocking = lanes.filter((l) => l.blocking)
  // A review with no blocking lane attests nothing (the manifest parser
  // rejects such a binding; this is the defensive twin).
  if (blocking.length === 0) return "incomplete"
  if (blocking.some((l) => l.status === "fail")) return "block"
  if (blocking.some((l) => l.status !== "pass")) return "incomplete"
  return "pass"
}
