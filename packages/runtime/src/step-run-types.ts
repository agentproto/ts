/**
 * Shared step/policy types for the imperative step-sequence runners
 * (`routine-runner.ts`'s RoutineRunner, `workflow-runner.ts`'s
 * WorkflowRunner). Neutral owner so neither runner depends on the other's
 * module for its public types — see PLAN.md "THE ordering constraint".
 */

export type RoutinePolicy =
  | { awaiting: "auto-allow"; prompt: string }
  | { awaiting: "escalate"; webhookUrl?: string; timeoutMs?: number }
  | { awaiting: "fail" }

export interface RoutineStep {
  label: string
  /** Prompt to send to the agent. Omit to just wait without prompting. */
  prompt?: string
  /** Adapter slug for spawning a NEW session. Omit to reuse the current
   *  run's last session. */
  adapter?: string
  /** Fan-in: wait for ALL these session ids to finish before executing. */
  waitFor?: string[]
  policy?: RoutinePolicy
}

export interface RoutineStepState {
  index: number
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  sessionId?: string
  startedAt?: string
  endedAt?: string
  error?: string
}

// ── RoutineRunner deprecation notice ────────────────────────────────
// RoutineRunner (`routine_start/status/cancel/escalation_resolve` +
// `/routines/*`) is being folded into AIP-15 workflow — see PLAN.md.
// Both the MCP tools (orchestration-tools.ts) and the HTTP routes
// (http-server.ts) call this so each deprecated surface logs once per
// process, not once per call.
const routineRunnerDeprecationLogged = new Set<string>()

export function logRoutineRunnerDeprecation(surface: string): void {
  if (routineRunnerDeprecationLogged.has(surface)) return
  routineRunnerDeprecationLogged.add(surface)
  console.warn(
    `[routine-runner] DEPRECATED: '${surface}' — use workflow_* instead; ` +
      "a sequence is a workflow with single-step stages. Removed next release.",
  )
}
