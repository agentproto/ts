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
 * The first decision of the winning outcome wins. An empty list allows.
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
