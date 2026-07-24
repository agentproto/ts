/**
 * PURE decision helper for windowed cost-budget caps (phase 4).
 *
 * A {@link CostBudget} (`@agentproto/auth`) is a windowed spend ceiling that
 * trips a GOVERNANCE POLICY — it does NOT kill a session. This module is the
 * side-effect-free predicate at its core: given a budget and an already-computed
 * windowed `spentUsd` (from the priced `rollupUsage` local-estimate), decide
 * whether the cap is crossed. No fs, no clock, no rollup here — the impure
 * spend computation (reading snapshots + `rollupUsage`) lives at the surface
 * (the supervisor's cost gate) and hands the summed dollars in, exactly as
 * `usage-rollup.ts` splits the pure fold from `usage-rollup-service.ts`'s
 * disk read.
 *
 * DISTINCT from the scalar `maxCostUsd` session-kill (`sessions.ts` turn-end):
 * that cap KILLS the session when cumulative cost exceeds it; a `CostBudget`
 * only reports "tripped", and the caller emits `policy:failed`. The two are
 * orthogonal and coexist.
 */
import type { CostBudget, CostBudgetScope } from "@agentproto/auth"

/**
 * The outcome of evaluating one windowed budget against a spend figure.
 * `tripped` is the pass/fail signal; the rest echoes the inputs so a caller
 * (event payload, log line, test) can render the decision without re-deriving
 * it. `overageUsd` is `0` whenever the budget is not tripped.
 */
export interface CostBudgetDecision {
  tripped: boolean
  spentUsd: number
  maxCostUsd: number
  window: string
  scope: CostBudgetScope
  overageUsd: number
}

/**
 * Decide whether `spentUsd` crosses `budget.maxCostUsd`.
 *
 * `tripped` is a STRICT `>` — spend exactly AT the cap is within budget (the
 * cap is the last allowed dollar, not the first denied one), matching the
 * scalar session-kill's own `> maxCostUsd` boundary (`sessions.ts:3489`).
 * `overageUsd` is the amount over the cap, clamped at 0 so an under-budget
 * decision never reports a negative overage.
 */
export function evaluateCostBudget(args: {
  budget: CostBudget
  spentUsd: number
}): CostBudgetDecision {
  const { budget, spentUsd } = args
  const maxCostUsd = budget.maxCostUsd
  const tripped = spentUsd > maxCostUsd
  const overageUsd = Math.max(0, spentUsd - maxCostUsd)
  return {
    tripped,
    spentUsd,
    maxCostUsd,
    window: budget.window,
    scope: budget.scope,
    overageUsd,
  }
}
