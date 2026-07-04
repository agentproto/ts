import {
  INVALID_SPAN_CONTEXT,
  type Context,
  type Exception,
  type Link,
  type Span,
  type SpanAttributes,
  type SpanAttributeValue,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TimeInput,
  type Tracer,
} from "@opentelemetry/api"
import { describe, expect, it } from "vitest"

import { composeTelemetry } from "../adapters.js"
import { otelTelemetry } from "../otel.js"
import type { Telemetry, TelemetryEvent } from "../ports.js"

/**
 * A transport-level event whose `kind` is outside this build's closed union —
 * models a future kernel emitting a new event type under the same
 * `agentproto/telemetry/v1` schema. Used only to exercise forward-compat.
 */
interface FutureEvent {
  readonly kind: "future.kind"
  readonly cycleId: string
  readonly at: string
}

/**
 * The transport-widened view of a sink. A `Telemetry` (closed union) is
 * assignable to this because `emit` is a method (bivariant parameters), which
 * is exactly the forward-compat contract: sinks accept kinds they don't model.
 */
interface ForwardCompatTelemetry {
  emit(event: TelemetryEvent | FutureEvent): void
}

/** A recorded call on a fake span, for assertions. */
type SpanCall =
  | { readonly op: "setAttribute"; readonly key: string; readonly value: SpanAttributeValue }
  | { readonly op: "addEvent"; readonly name: string }
  | { readonly op: "setStatus"; readonly status: SpanStatus }
  | { readonly op: "recordException"; readonly exception: Exception }
  | { readonly op: "end" }

class FakeSpan implements Span {
  readonly name: string
  readonly calls: SpanCall[] = []
  ended = false

  constructor(name: string) {
    this.name = name
  }

  spanContext(): SpanContext {
    return INVALID_SPAN_CONTEXT
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.calls.push({ op: "setAttribute", key, value })
    return this
  }

  setAttributes(attributes: SpanAttributes): this {
    for (const key of Object.keys(attributes)) {
      const value = attributes[key]
      if (value !== undefined) this.calls.push({ op: "setAttribute", key, value })
    }
    return this
  }

  addEvent(name: string): this {
    this.calls.push({ op: "addEvent", name })
    return this
  }

  addLink(_link: Link): this {
    return this
  }

  addLinks(_links: Link[]): this {
    return this
  }

  setStatus(status: SpanStatus): this {
    this.calls.push({ op: "setStatus", status })
    return this
  }

  updateName(_name: string): this {
    return this
  }

  end(_endTime?: TimeInput): void {
    this.ended = true
    this.calls.push({ op: "end" })
  }

  isRecording(): boolean {
    return !this.ended
  }

  recordException(exception: Exception, _time?: TimeInput): void {
    this.calls.push({ op: "recordException", exception })
  }
}

class FakeTracer implements Tracer {
  readonly spans: FakeSpan[] = []

  startSpan(name: string, _options?: SpanOptions, _context?: Context): Span {
    const span = new FakeSpan(name)
    this.spans.push(span)
    return span
  }

  // The adapter under test only uses `startSpan`; this arm exists solely to
  // satisfy the `Tracer` interface. It is never exercised.
  startActiveSpan(): never {
    throw new Error("FakeTracer.startActiveSpan is not used by the adapter")
  }
}

/** Fetch a recorded span by index, failing loudly if it wasn't created. */
function spanAt(tracer: FakeTracer, index: number): FakeSpan {
  const span = tracer.spans[index]
  if (!span) throw new Error(`expected a span at index ${index}`)
  return span
}

const at = "2026-07-04T00:00:00.000Z"

describe("otelTelemetry", () => {
  it("opens and closes cycle + participant spans for a full cycle", () => {
    const tracer = new FakeTracer()
    const telemetry = otelTelemetry(tracer)

    telemetry.emit({ kind: "cycle.started", cycleId: "c1", at, since: "t0" })
    telemetry.emit({
      kind: "participant.started",
      cycleId: "c1",
      at,
      participantId: "p1",
      executorKind: "agent-cli",
    })
    telemetry.emit({
      kind: "participant.finished",
      cycleId: "c1",
      at,
      participantId: "p1",
      executorKind: "agent-cli",
      durationMs: 42,
      contentLength: 128,
    })
    telemetry.emit({
      kind: "cycle.finished",
      cycleId: "c1",
      at,
      outcome: "executed",
      turnsAppended: 1,
      durationMs: 99,
    })

    expect(tracer.spans.map((s) => s.name)).toEqual([
      "agentproto.cycle",
      "agentproto.participant",
    ])

    const cycle = spanAt(tracer, 0)
    const participant = spanAt(tracer, 1)

    // Participant span ended BEFORE the cycle span.
    const participantEndIdx = participant.calls.findIndex((c) => c.op === "end")
    const cycleEndIdx = cycle.calls.findIndex((c) => c.op === "end")
    expect(participantEndIdx).toBeGreaterThanOrEqual(0)
    expect(cycleEndIdx).toBeGreaterThanOrEqual(0)
    expect(participant.ended).toBe(true)
    expect(cycle.ended).toBe(true)

    // Participant carries duration + content attrs.
    expect(participant.calls).toContainEqual({
      op: "setAttribute",
      key: "agentproto.participant.durationMs",
      value: 42,
    })
    expect(participant.calls).toContainEqual({
      op: "setAttribute",
      key: "agentproto.participant.contentLength",
      value: 128,
    })

    // Cycle carries outcome.
    expect(cycle.calls).toContainEqual({
      op: "setAttribute",
      key: "agentproto.cycle.outcome",
      value: "executed",
    })
  })

  it("records the exception and ends the span on participant.failed", () => {
    const tracer = new FakeTracer()
    const telemetry = otelTelemetry(tracer)

    telemetry.emit({ kind: "cycle.started", cycleId: "c1", at })
    telemetry.emit({
      kind: "participant.started",
      cycleId: "c1",
      at,
      participantId: "p1",
      executorKind: "agent-cli",
    })
    telemetry.emit({
      kind: "participant.failed",
      cycleId: "c1",
      at,
      participantId: "p1",
      executorKind: "agent-cli",
      error: "boom",
    })

    const participant = spanAt(tracer, 1)
    expect(participant.calls.some((c) => c.op === "recordException")).toBe(true)
    expect(participant.calls.some((c) => c.op === "setStatus")).toBe(true)
    expect(participant.ended).toBe(true)
  })

  it("adds cycle-scoped events for substrate.read and dispatch.decided", () => {
    const tracer = new FakeTracer()
    const telemetry = otelTelemetry(tracer)

    telemetry.emit({ kind: "cycle.started", cycleId: "c1", at })
    telemetry.emit({
      kind: "substrate.read",
      cycleId: "c1",
      at,
      substrateKind: "memory",
      turnCount: 3,
      durationMs: 5,
    })
    telemetry.emit({
      kind: "dispatch.decided",
      cycleId: "c1",
      at,
      dispatcherKind: "round-robin",
      selected: ["p1"],
      durationMs: 2,
    })

    const cycle = spanAt(tracer, 0)
    const eventNames = cycle.calls.flatMap((c) =>
      c.op === "addEvent" ? [c.name] : []
    )
    expect(eventNames).toEqual(["substrate.read", "dispatch.decided"])
  })

  it("ignores unknown event kinds (forward-compat no-op)", () => {
    const tracer = new FakeTracer()
    const telemetry: Telemetry = otelTelemetry(tracer)

    // A future kernel version may emit a kind this build doesn't know. Viewed
    // through the transport-widened sink contract, the event is well-formed.
    const forwardCompat: ForwardCompatTelemetry = telemetry
    forwardCompat.emit({ kind: "future.kind", cycleId: "c1", at })

    expect(tracer.spans).toHaveLength(0)
  })
})

describe("composeTelemetry", () => {
  it("fans out to every sink and isolates a throwing sink", () => {
    const seenA: string[] = []
    const seenB: string[] = []
    const throwing: Telemetry = {
      emit() {
        throw new Error("sink A failed")
      },
    }
    const a: Telemetry = { emit: (e) => seenA.push(e.kind) }
    const b: Telemetry = { emit: (e) => seenB.push(e.kind) }

    const composed = composeTelemetry(throwing, a, b)
    composed.emit({ kind: "cycle.idle", cycleId: "c1", at })

    // The throwing sink did not block the others.
    expect(seenA).toEqual(["cycle.idle"])
    expect(seenB).toEqual(["cycle.idle"])
  })
})
