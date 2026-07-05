/**
 * Reference Telemetry adapters.
 *
 * Wire `RuntimePorts.telemetry` to one of these (or your own
 * implementation) to receive structured events from each cycle.
 * Sinks may also be composed via `composeTelemetry()`.
 *
 * These are re-exported from `@agentproto/telemetry` — kept here so
 * every existing `from "./adapters/telemetry.js"` consumer is unchanged.
 */

export {
  noopTelemetry,
  stderrTelemetry,
  arrayTelemetry,
  composeTelemetry,
  type StderrTelemetryOptions,
} from "@agentproto/telemetry"
