/**
 * BYOK (Bring Your Own Keys) policy.
 *
 * Single pure function — `shouldDebit` — that decides whether a model
 * run should debit user credits or be recorded as a non-debiting shadow
 * usage row. Truth table mirrors the open-coded behavior at
 * `apps/guilde/api/src/mastra/operator-orchestrator/utils.ts:1539-1672`
 * (commit `eeb1acdc`):
 *
 *   byokActive | hasConnector | result
 *   -----------|--------------|----------------------------------
 *   true       | true         | { debit: false, shadow: true }
 *   true       | false        | { debit: true,  shadow: false }   ← BYOK flag set but no key — fall back to credits
 *   false      | true         | { debit: true,  shadow: false }
 *   false      | false        | { debit: true,  shadow: false }
 *
 * No DB calls, no I/O. Caller (orchestrator, MCP server) is responsible
 * for resolving `byokActive` and `hasConnector` upstream.
 */

export interface ShouldDebitInput {
  modelId: string
  byokActive: boolean
  hasConnector: boolean
}

export interface ShouldDebitDecision {
  debit: boolean
  shadow: boolean
  /** Stable string for logs/metrics; not user-facing copy. */
  reason:
    | "byok-active-with-connector"
    | "byok-flag-but-no-connector"
    | "non-byok"
}

export function shouldDebit(input: ShouldDebitInput): ShouldDebitDecision {
  if (input.byokActive && input.hasConnector) {
    return {
      debit: false,
      shadow: true,
      reason: "byok-active-with-connector",
    }
  }
  if (input.byokActive && !input.hasConnector) {
    return {
      debit: true,
      shadow: false,
      reason: "byok-flag-but-no-connector",
    }
  }
  return { debit: true, shadow: false, reason: "non-byok" }
}
