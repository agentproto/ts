import { describe, expect, it, vi } from "vitest"
import {
  arrayTelemetry,
  composeTelemetry,
  noopTelemetry,
  stderrTelemetry,
} from "../adapters.js"
import type { TelemetryEvent } from "../ports.js"

/** A custom, non-telemetry discriminated union to prove the port is generic. */
type CustomEvent =
  | { readonly kind: "job.started"; readonly runId: string; readonly at: string }
  | {
      readonly kind: "job.finished"
      readonly runId: string
      readonly at: string
      readonly ok: boolean
    }

describe("generic telemetry adapters", () => {
  it("arrayTelemetry collects a custom event type with full typing", () => {
    const sink = arrayTelemetry<CustomEvent>()
    sink.emit({ kind: "job.started", runId: "r1", at: "t0" })
    sink.emit({ kind: "job.finished", runId: "r1", at: "t1", ok: true })

    expect(sink.events).toHaveLength(2)
    const [first, second] = sink.events
    expect(first?.kind).toBe("job.started")
    // Discriminated narrowing works on the collected custom union.
    if (second?.kind === "job.finished") {
      expect(second.ok).toBe(true)
    } else {
      throw new Error("expected job.finished")
    }
  })

  it("composeTelemetry fans a custom event out to every sink", () => {
    const a = arrayTelemetry<CustomEvent>()
    const b = arrayTelemetry<CustomEvent>()
    const composed = composeTelemetry<CustomEvent>(a, b)

    composed.emit({ kind: "job.started", runId: "r2", at: "t0" })
    composed.emit({ kind: "job.finished", runId: "r2", at: "t1", ok: false })

    expect(a.events).toEqual(b.events)
    expect(a.events.map((e) => e.kind)).toEqual(["job.started", "job.finished"])
  })

  it("noopTelemetry() satisfies a custom sink and swallows events", () => {
    const sink = noopTelemetry<CustomEvent>()
    expect(() => sink.emit({ kind: "job.started", runId: "r3", at: "t0" })).not.toThrow()
  })

  it("stderrTelemetry accepts a custom formatter for a custom event type", () => {
    const written: string[] = []
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(typeof chunk === "string" ? chunk : chunk.toString())
        return true
      })
    try {
      const sink = stderrTelemetry<CustomEvent>({
        prefix: "job: ",
        format: (e) => `${e.kind} ${e.runId}`,
      })
      sink.emit({ kind: "job.started", runId: "r4", at: "t0" })
    } finally {
      spy.mockRestore()
    }
    expect(written).toEqual(["job: job.started r4\n"])
  })

  it("stays backward compatible for the default TelemetryEvent union", () => {
    const sink = arrayTelemetry()
    const event: TelemetryEvent = {
      kind: "cycle.started",
      cycleId: "c1",
      at: "t0",
    }
    sink.emit(event)
    const composed = composeTelemetry(sink, noopTelemetry())
    composed.emit(event)
    expect(sink.events).toHaveLength(2)
    expect(sink.events[0]?.kind).toBe("cycle.started")
  })
})
