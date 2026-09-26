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
  /** The step's own output, when it completed successfully — omitted from
   *  `workflow_status`'s compact form (AIP-58 §9 `run.get` compact
   *  boundary), included with `full: true`. */
  output?: unknown
  /** Last `kind: "gate"` command attempt's outcome, when this step is a
   *  gate (AIP-15 P3) — updated on every attempt, not just the final one. */
  gateReport?: { ok: boolean; exitCode: number; report: unknown; attempt: number }
  /** AIP-58 §3 Outcome rule: set while this step is parked awaiting an
   *  explicit `run.requestInput` signal — cleared on resume (it may be set
   *  again if the resumed step suspends a second time). Mirrors AIP-58's
   *  `StepRecord.suspend` exactly, for the transcriber UI contract. */
  suspend?: { reason: "input-required"; prompt: string; schema?: Record<string, unknown> }
  /** AIP-58 §3 Outcome rule: set on a `failed { code: "missing-output" }`
   *  step whose final message matched the "trailing question mark"
   *  heuristic — a triage aid only, it never changes `status`. */
  hint?: "possible-input-request"
  /** True when this step's output was replayed from the run's step-cache
   *  journal (`cacheable: true` + `cacheKey`) instead of being executed. */
  cached?: boolean
}
