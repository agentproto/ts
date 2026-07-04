/**
 * Vendor-neutral Telemetry port.
 *
 * This package OWNS the telemetry contract so any runtime can depend on a
 * single interface without pulling in a kernel. It is a LEAF — it imports
 * nothing from a runtime; runtimes depend on IT.
 *
 * The two referenced id types are mirrored locally (plain `string`) so the
 * port has no upstream dependency. A runtime may use branded ids; they widen
 * to `string` and remain assignable here.
 */

export type ParticipantId = string
export type TurnId = string

/**
 * Discriminated union of every event a kernel emits during a cycle.
 *
 * Every event carries `cycleId` (a per-cycle ULID-ish identifier) and
 * `at` (ISO timestamp), so a sink can rebuild OTEL-style spans by
 * grouping on cycleId.
 *
 * Sinks MUST tolerate unknown kinds — future kernel versions may add
 * event types under the same `agentproto/telemetry/v1` schema.
 */
export type TelemetryEvent =
  | {
      readonly kind: "cycle.started"
      readonly cycleId: string
      readonly at: string
      readonly since?: TurnId
    }
  | {
      readonly kind: "substrate.read"
      readonly cycleId: string
      readonly at: string
      readonly substrateKind: string
      readonly turnCount: number
      readonly durationMs: number
    }
  | {
      readonly kind: "dispatch.decided"
      readonly cycleId: string
      readonly at: string
      readonly dispatcherKind: string
      readonly selected: readonly ParticipantId[]
      readonly durationMs: number
    }
  | {
      readonly kind: "participant.started"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
      readonly executorKind: string
    }
  | {
      readonly kind: "participant.finished"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
      readonly executorKind: string
      readonly durationMs: number
      readonly contentLength: number
    }
  | {
      readonly kind: "participant.failed"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
      readonly executorKind: string
      readonly error: string
    }
  | {
      readonly kind: "substrate.appended"
      readonly cycleId: string
      readonly at: string
      readonly turnId: TurnId
      readonly participantId: ParticipantId
    }
  | {
      readonly kind: "state.written"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
    }
  | {
      readonly kind: "cycle.idle"
      readonly cycleId: string
      readonly at: string
    }
  | {
      readonly kind: "cycle.finished"
      readonly cycleId: string
      readonly at: string
      readonly outcome: "executed" | "idle"
      readonly turnsAppended: number
      readonly durationMs: number
    }

/**
 * Structured-event sink. Wire to log lines, an OTEL exporter, an in-memory
 * array (tests), or anything else. Implementations MUST tolerate unknown
 * event kinds (forward-compat under `agentproto/telemetry/v1`).
 *
 * The port is generic over the event type `E` so a downstream package can
 * carry its OWN discriminated union through the same sink contract (e.g.
 * `Telemetry<EvalEvent>`). The default `E = TelemetryEvent` keeps every
 * existing usage — `Telemetry` written with no type argument — unchanged.
 */
export interface Telemetry<E = TelemetryEvent> {
  emit(event: E): void
}
