/**
 * Reference Telemetry adapters.
 *
 * Wire `RuntimePorts.telemetry` to one of these (or your own
 * implementation) to receive structured events from each cycle.
 * Sinks may also be composed via `composeTelemetry()`.
 */

import type { Telemetry, TelemetryEvent } from "./ports.js"

/**
 * No-op sink. Equivalent to leaving `telemetry` undefined on RuntimePorts.
 *
 * A factory generic over the event type `E` (default `TelemetryEvent`) so it
 * satisfies `Telemetry<E>` for any downstream union. `noopTelemetry()` with no
 * type argument returns the ordinary `Telemetry<TelemetryEvent>` sink.
 */
export function noopTelemetry<E = TelemetryEvent>(): Telemetry<E> {
  return {
    emit() {
      // intentionally blank
    },
  }
}

export interface StderrTelemetryOptions<E = TelemetryEvent> {
  /** Event kinds to include. Omit to emit all kinds. */
  readonly include?: ReadonlySet<TelemetryEvent["kind"]>
  /** Event kinds to suppress. Wins over `include`. */
  readonly exclude?: ReadonlySet<TelemetryEvent["kind"]>
  /** Prefix prepended to every line. Default "agentproto: ". */
  readonly prefix?: string
  /**
   * Render a line for an event. Required when `E` is not `TelemetryEvent`
   * (the built-in formatter only understands the concrete telemetry union).
   * When omitted, the built-in `TelemetryEvent` formatter is used — valid only
   * for the default `E = TelemetryEvent`.
   */
  readonly format?: (event: E) => string
}

/**
 * Human-readable stderr sink — one line per event. Cheaper than wiring
 * a real exporter; good default for `--verbose` mode.
 *
 * Generic over the event type `E`. For a custom `E`, pass `format` — the
 * built-in formatter is `TelemetryEvent`-specific. The `include`/`exclude`
 * filters key on `event.kind`, which every telemetry-shaped event carries.
 */
export function stderrTelemetry<E = TelemetryEvent>(
  options: StderrTelemetryOptions<E> = {}
): Telemetry<E> {
  const prefix = options.prefix ?? "agentproto: "
  const format = options.format ?? defaultFormat
  return {
    emit(event) {
      const kind = kindOf(event)
      if (kind !== undefined && setHas(options.exclude, kind)) return
      if (kind !== undefined && options.include && !setHas(options.include, kind))
        return
      process.stderr.write(`${prefix}${format(event)}\n`)
    },
  }
}

/**
 * Membership test that accepts a plain `string` probe against a set of literal
 * kinds — avoids an `as` cast on the discriminant while keeping the public
 * option type (`ReadonlySet<TelemetryEvent["kind"]>`) narrow for callers.
 */
function setHas(
  set: ReadonlySet<string> | undefined,
  value: string,
): boolean {
  return set !== undefined && set.has(value)
}

/**
 * The built-in stderr formatter, usable only when `E = TelemetryEvent`.
 * Wrapped so it satisfies the generic `(event: E) => string` default without a
 * cast: it narrows through {@link isTelemetryEvent} and JSON-renders anything
 * else (forward-compat, same contract as {@link formatEvent}'s default arm).
 */
function defaultFormat<E>(event: E): string {
  return isTelemetryEvent(event) ? formatEvent(event) : JSON.stringify(event)
}

/** Read a `kind` discriminant off an event, if it carries one. */
function kindOf(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  if (!("kind" in event)) return undefined
  const kind: unknown = event.kind
  return typeof kind === "string" ? kind : undefined
}

/** Structural guard: is this a concrete {@link TelemetryEvent}? */
function isTelemetryEvent(event: unknown): event is TelemetryEvent {
  return kindOf(event) !== undefined
}

/**
 * In-memory sink — every event pushed onto an array. Intended for
 * tests; reach into `events` after `runTurn` to assert. Generic over the
 * event type `E` so a custom union's events collect with full typing.
 */
export function arrayTelemetry<E = TelemetryEvent>(): Telemetry<E> & {
  readonly events: readonly E[]
} {
  const events: E[] = []
  return {
    events,
    emit(event) {
      events.push(event)
    },
  }
}

/**
 * Fan-out — emits every event to all wrapped sinks in order. Useful
 * for "log to stderr AND export to OTEL" setups. Generic over the event
 * type `E`; every wrapped sink shares the same `E`.
 */
export function composeTelemetry<E = TelemetryEvent>(
  ...sinks: readonly Telemetry<E>[]
): Telemetry<E> {
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
