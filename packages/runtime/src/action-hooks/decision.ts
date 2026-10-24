/**
 * Admission decision precedence for action hooks.
 */

import type { AdmissionDecision } from "./types.js"

const RANK: Record<AdmissionDecision["outcome"], number> = {
  deny: 3,
  reuse: 2,
  defer: 1,
  allow: 0,
}

/**
 * Combine decisions with precedence `deny > reuse > defer > allow`.
 * Deny wins because admission can only narrow. Reuse beats defer because reuse
 * points at an existing result while defer only postpones. AIP-71 does not
 * order reuse and defer, this ordering is the local choice of the action hooks
 * plan. The first decision of the winning outcome wins. An empty list allows.
 */
export function combineAdmissionDecisions(
  decisions: readonly AdmissionDecision[],
): AdmissionDecision {
  let best: AdmissionDecision | undefined
  for (const decision of decisions) {
    if (!best || RANK[decision.outcome] > RANK[best.outcome]) best = decision
  }
  return best ?? { outcome: "allow" }
}

/** Native harness hooks can express only allow and deny. */
export function isNativeExpressible(decision: AdmissionDecision): boolean {
  return decision.outcome === "allow" || decision.outcome === "deny"
}
