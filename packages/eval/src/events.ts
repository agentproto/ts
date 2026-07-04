/**
 * Structured events emitted while an eval suite runs.
 *
 * The union mirrors the shape of `@agentproto/telemetry`'s `TelemetryEvent`:
 * a discriminated union keyed on `kind`, every member carrying a correlation
 * id (`runId`) and an ISO `at` timestamp so a sink can rebuild a per-run span
 * tree. It rides the same {@link Telemetry} port — a `runEval` call takes a
 * `Telemetry<EvalEvent>` sink.
 *
 * Sinks MUST tolerate unknown kinds — future versions may add event types
 * under the same `agentproto/eval/v1` schema (identical forward-compat
 * contract as the telemetry port).
 */

/** Schema identifier for this event family. */
export const EVAL_EVENT_SCHEMA = "agentproto/eval/v1" as const

export type EvalEvent =
  | {
      readonly kind: "eval.started"
      readonly runId: string
      readonly at: string
      readonly suiteId: string
      readonly caseCount: number
      readonly scorerCount: number
    }
  | {
      readonly kind: "eval.case.started"
      readonly runId: string
      readonly at: string
      readonly caseId: string
    }
  | {
      readonly kind: "eval.case.scored"
      readonly runId: string
      readonly at: string
      readonly caseId: string
      readonly scorerId: string
      readonly value: number
      readonly passed: boolean
    }
  | {
      readonly kind: "eval.case.finished"
      readonly runId: string
      readonly at: string
      readonly caseId: string
      /** True when EVERY scorer bound to the case passed. */
      readonly passed: boolean
    }
  | {
      readonly kind: "eval.finished"
      readonly runId: string
      readonly at: string
      readonly suiteId: string
      readonly total: number
      readonly passedCount: number
      readonly meanValue: number
      readonly durationMs: number
    }
