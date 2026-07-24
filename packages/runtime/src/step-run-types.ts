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

export interface RoutineStepState {
  index: number
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  sessionId?: string
  startedAt?: string
  endedAt?: string
  error?: string
}
