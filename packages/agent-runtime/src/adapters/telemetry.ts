/**
 * Reference Telemetry adapters.
 *
 * Wire `RuntimePorts.telemetry` to one of these (or your own
 * implementation) to receive structured events from each cycle.
 * Sinks may also be composed via `composeTelemetry()`.
 */

import type { Telemetry, TelemetryEvent } from "../ports.js"

/** No-op sink. Equivalent to leaving `telemetry` undefined on RuntimePorts. */
export const noopTelemetry: Telemetry = {
  emit() {
    // intentionally blank
  },
}

export interface StderrTelemetryOptions {
  /** Event kinds to include. Omit to emit all kinds. */
  readonly include?: ReadonlySet<TelemetryEvent["kind"]>
  /** Event kinds to suppress. Wins over `include`. */
  readonly exclude?: ReadonlySet<TelemetryEvent["kind"]>
  /** Prefix prepended to every line. Default "agentproto: ". */
  readonly prefix?: string
}

/**
 * Human-readable stderr sink — one line per event. Cheaper than wiring
 * a real exporter; good default for `--verbose` mode.
 */
export function stderrTelemetry(
  options: StderrTelemetryOptions = {}
): Telemetry {
  const prefix = options.prefix ?? "agentproto: "
  return {
    emit(event) {
      if (options.exclude?.has(event.kind)) return
      if (options.include && !options.include.has(event.kind)) return
      process.stderr.write(`${prefix}${formatEvent(event)}\n`)
    },
  }
}

/**
 * In-memory sink — every event pushed onto an array. Intended for
 * tests; reach into `events` after `runTurn` to assert.
 */
export function arrayTelemetry(): Telemetry & {
  readonly events: readonly TelemetryEvent[]
} {
  const events: TelemetryEvent[] = []
  return {
    events,
    emit(event) {
      events.push(event)
    },
  }
}

/**
 * Fan-out — emits every event to all wrapped sinks in order. Useful
 * for "log to stderr AND export to OTEL" setups.
 */
export function composeTelemetry(...sinks: readonly Telemetry[]): Telemetry {
  return {
    emit(event) {
      for (const sink of sinks) {
        try {
          sink.emit(event)
        } catch {
          // Each sink is independently isolated.
        }
      }
    },
  }
}

function formatEvent(event: TelemetryEvent): string {
  switch (event.kind) {
    case "cycle.started":
      return `${event.cycleId} cycle.started${event.since !== undefined ? ` since=${event.since}` : ""}`
    case "substrate.read":
      return `${event.cycleId} substrate.read ${event.substrateKind} turns=${event.turnCount} ${event.durationMs}ms`
    case "dispatch.decided":
      return `${event.cycleId} dispatch.decided ${event.dispatcherKind} selected=[${event.selected.join(",") || "(none)"}] ${event.durationMs}ms`
    case "participant.started":
      return `${event.cycleId} participant.started ${event.participantId} (${event.executorKind})`
    case "participant.finished":
      return `${event.cycleId} participant.finished ${event.participantId} ${event.durationMs}ms content=${event.contentLength}b`
    case "participant.failed":
      return `${event.cycleId} participant.failed ${event.participantId} — ${event.error}`
    case "substrate.appended":
      return `${event.cycleId} substrate.appended turn=${event.turnId} by=${event.participantId}`
    case "state.written":
      return `${event.cycleId} state.written ${event.participantId}`
    case "cycle.idle":
      return `${event.cycleId} cycle.idle`
    case "cycle.finished":
      return `${event.cycleId} cycle.finished ${event.outcome} appended=${event.turnsAppended} ${event.durationMs}ms`
    default: {
      // Forward-compat — render unknown kinds as JSON so a future
      // kernel version doesn't blank-line the log.
      const _exhaustive: never = event
      return JSON.stringify(_exhaustive)
    }
  }
}
