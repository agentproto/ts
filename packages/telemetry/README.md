# @agentproto/telemetry

Vendor-neutral **Telemetry** port for the agentproto runtime kernel, plus
reference sinks and an OpenTelemetry adapter.

A runtime emits a stream of structured `TelemetryEvent`s during each cycle —
every event carries a `cycleId` and an ISO `at` timestamp, so a sink can rebuild
OTEL-style spans by grouping on `cycleId`. Events are schema
`agentproto/telemetry/v1`; **sinks must tolerate unknown kinds** (future kernel
versions may add event types under the same schema).

This package is a **leaf**: it owns the port and depends on no runtime. Runtimes
depend on it.

## The port

```ts
import type { Telemetry, TelemetryEvent } from "@agentproto/telemetry"

interface Telemetry {
  emit(event: TelemetryEvent): void
}
```

## Reference sinks

- `noopTelemetry` — drops everything. Same as leaving telemetry unset.
- `stderrTelemetry(opts?)` — one human-readable line per event, with
  `include` / `exclude` kind filters and a `prefix`.
- `arrayTelemetry()` — pushes every event onto `.events`; for tests.
- `composeTelemetry(...sinks)` — fan-out to many sinks, each isolated (one
  throwing does not block the others).

```ts
import { composeTelemetry, stderrTelemetry } from "@agentproto/telemetry"

const telemetry = composeTelemetry(stderrTelemetry({ prefix: "run: " }), otel)
```

## OpenTelemetry adapter

`otelTelemetry(tracer)` maps the event stream onto OTel spans. It is a **pure
mapper** — the host supplies the `Tracer` (peer dependency
`@opentelemetry/api`). No global provider, no exporter wiring.

```ts
import { trace } from "@opentelemetry/api"
import { otelTelemetry } from "@agentproto/telemetry"

const tracer = trace.getTracer("my-runtime")
const telemetry = otelTelemetry(tracer)

// hand `telemetry` to the runtime; each cycle becomes an `agentproto.cycle`
// span with `agentproto.participant` child spans.
```

Mapping:

| Event | OTel effect |
| --- | --- |
| `cycle.started` | start root span `agentproto.cycle`, held per `cycleId` |
| `participant.started` | child span `agentproto.participant` (participantId, executorKind) |
| `participant.finished` | end child span (durationMs, contentLength attrs) |
| `participant.failed` | `recordException` + `ERROR` status, then end |
| `substrate.read` / `dispatch.decided` / … | `addEvent` on the cycle span |
| `cycle.finished` / `cycle.idle` | outcome attrs, end the cycle span |
| unknown kind | ignored silently (forward-compat) |

## License

MIT
