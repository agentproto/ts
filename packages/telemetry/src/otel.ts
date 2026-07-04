/**
 * OpenTelemetry adapter for the vendor-neutral Telemetry port.
 *
 * `otelTelemetry(tracer)` returns a `Telemetry` sink that maps the kernel's
 * `TelemetryEvent` stream onto OTel spans, grouping on `cycleId`:
 *
 *   cycle.started        → root span `agentproto.cycle` (held per cycleId)
 *   participant.started  → child span `agentproto.participant`
 *   participant.finished → end child span (durationMs, contentLength attrs)
 *   participant.failed   → recordException + ERROR status, then end
 *   substrate.read       → addEvent on the cycle span
 *   dispatch.decided     → addEvent on the cycle span
 *   cycle.finished/idle  → outcome attrs, end the cycle span, drop from map
 *   unknown kind         → ignored silently (forward-compat contract)
 *
 * This is a PURE MAPPER: the host supplies the `Tracer`. No global provider,
 * no exporter, no context propagation beyond parenting child spans under the
 * cycle span.
 */

import {
  context,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api"

import type { Telemetry, TelemetryEvent } from "./ports.js"

export interface OtelTelemetryOptions {
  /** Span name for the per-cycle root span. Default "agentproto.cycle". */
  readonly cycleSpanName?: string
  /** Span name for each participant child span. Default "agentproto.participant". */
  readonly participantSpanName?: string
}

/**
 * Build a `Telemetry` sink that projects events onto OTel spans via the
 * host-supplied `tracer`.
 */
export function otelTelemetry(
  tracer: Tracer,
  options: OtelTelemetryOptions = {}
): Telemetry {
  const cycleSpanName = options.cycleSpanName ?? "agentproto.cycle"
  const participantSpanName =
    options.participantSpanName ?? "agentproto.participant"

  const cycleSpans = new Map<string, Span>()
  const participantSpans = new Map<string, Map<string, Span>>()

  const startChild = (parent: Span, name: string): Span => {
    const parentCtx = trace.setSpan(context.active(), parent)
    return tracer.startSpan(name, undefined, parentCtx)
  }

  const dropParticipant = (cycleId: string, participantId: string): Span | undefined => {
    const byParticipant = participantSpans.get(cycleId)
    const span = byParticipant?.get(participantId)
    if (byParticipant && span) {
      byParticipant.delete(participantId)
      if (byParticipant.size === 0) participantSpans.delete(cycleId)
    }
    return span
  }

  const endCycle = (event: Extract<TelemetryEvent, { kind: "cycle.finished" | "cycle.idle" }>): void => {
    const span = cycleSpans.get(event.cycleId)
    if (!span) return
    if (event.kind === "cycle.finished") {
      span.setAttribute("agentproto.cycle.outcome", event.outcome)
      span.setAttribute("agentproto.cycle.turnsAppended", event.turnsAppended)
      span.setAttribute("agentproto.cycle.durationMs", event.durationMs)
    } else {
      span.setAttribute("agentproto.cycle.outcome", "idle")
    }
    // Any participant spans still open are orphaned by an incomplete cycle;
    // end them so the tracer isn't left with dangling spans.
    const orphans = participantSpans.get(event.cycleId)
    if (orphans) {
      for (const child of orphans.values()) child.end()
      participantSpans.delete(event.cycleId)
    }
    span.end()
    cycleSpans.delete(event.cycleId)
  }

  return {
    emit(event: TelemetryEvent): void {
      switch (event.kind) {
        case "cycle.started": {
          const span = tracer.startSpan(cycleSpanName)
          span.setAttribute("agentproto.cycleId", event.cycleId)
          if (event.since !== undefined) {
            span.setAttribute("agentproto.cycle.since", event.since)
          }
          cycleSpans.set(event.cycleId, span)
          return
        }
        case "participant.started": {
          const cycleSpan = cycleSpans.get(event.cycleId)
          if (!cycleSpan) return
          const span = startChild(cycleSpan, participantSpanName)
          span.setAttribute("agentproto.participantId", event.participantId)
          span.setAttribute("agentproto.executorKind", event.executorKind)
          let byParticipant = participantSpans.get(event.cycleId)
          if (!byParticipant) {
            byParticipant = new Map<string, Span>()
            participantSpans.set(event.cycleId, byParticipant)
          }
          byParticipant.set(event.participantId, span)
          return
        }
        case "participant.finished": {
          const span = dropParticipant(event.cycleId, event.participantId)
          if (!span) return
          span.setAttribute("agentproto.participant.durationMs", event.durationMs)
          span.setAttribute("agentproto.participant.contentLength", event.contentLength)
          span.end()
          return
        }
        case "participant.failed": {
          const span = dropParticipant(event.cycleId, event.participantId)
          if (!span) return
          span.recordException({ name: "ParticipantExecuteError", message: event.error })
          span.setStatus({ code: SpanStatusCode.ERROR, message: event.error })
          span.end()
          return
        }
        case "substrate.read": {
          const span = cycleSpans.get(event.cycleId)
          span?.addEvent("substrate.read", {
            "agentproto.substrateKind": event.substrateKind,
            "agentproto.turnCount": event.turnCount,
            "agentproto.durationMs": event.durationMs,
          })
          return
        }
        case "dispatch.decided": {
          const span = cycleSpans.get(event.cycleId)
          span?.addEvent("dispatch.decided", {
            "agentproto.dispatcherKind": event.dispatcherKind,
            "agentproto.selected": event.selected.join(","),
            "agentproto.durationMs": event.durationMs,
          })
          return
        }
        case "substrate.appended": {
          const span = cycleSpans.get(event.cycleId)
          span?.addEvent("substrate.appended", {
            "agentproto.turnId": event.turnId,
            "agentproto.participantId": event.participantId,
          })
          return
        }
        case "state.written": {
          const span = cycleSpans.get(event.cycleId)
          span?.addEvent("state.written", {
            "agentproto.participantId": event.participantId,
          })
          return
        }
        case "cycle.finished":
        case "cycle.idle": {
          endCycle(event)
          return
        }
        default: {
          // Unknown kind — forward-compat contract: ignore silently.
          return
        }
      }
    },
  }
}
