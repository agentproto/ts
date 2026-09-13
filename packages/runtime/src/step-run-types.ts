/**
 * Shared step/policy types for `workflow-runner.ts`'s WorkflowRunner and
 * `sessions-registry-agent-host.ts`'s escalation handling.
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
  /** Last `kind: "gate"` command attempt's outcome, when this step is a
   *  gate (AIP-15 P3) — updated on every attempt, not just the final one. */
  gateReport?: { ok: boolean; exitCode: number; report: unknown; attempt: number }
}
