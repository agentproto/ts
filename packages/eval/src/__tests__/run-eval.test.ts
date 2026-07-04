import { describe, expect, it } from "vitest"
import { arrayTelemetry } from "@agentproto/telemetry"
import {
  runEval,
  bindScorer,
  evalScorersProvider,
  exactMatchTool,
  latencyBudgetTool,
  type EvalEvent,
  type TypedEvalSuite,
} from "../index.js"

/** The target output the fake `target` produces for each case. */
interface Answer {
  readonly text: string
  readonly latencyMs: number
}

/**
 * A tiny suite: an exact-match binding + a latency-budget binding, scoring a
 * fake target's `{ text, latencyMs }` output. `expected` carries the reference
 * text as JSON.
 */
function buildSuite(): TypedEvalSuite<{ prompt: string }, Answer> {
  return {
    id: "greeting-suite",
    cases: [
      { id: "hello", input: { prompt: "hi" }, expected: "hello" },
      { id: "world", input: { prompt: "wo" }, expected: "world" },
      { id: "slow", input: { prompt: "sl" }, expected: "slow" },
    ],
    scorers: [
      bindScorer<Answer, { actual: string; expected: string }>({
        id: "exact",
        tool: exactMatchTool,
        driver: evalScorersProvider,
        mapInput: ({ output, expected }) => ({
          actual: output.text,
          expected: typeof expected === "string" ? expected : "",
        }),
      }),
      bindScorer<Answer, { durationMs: number; budgetMs: number }>({
        id: "latency",
        tool: latencyBudgetTool,
        driver: evalScorersProvider,
        mapInput: ({ output }) => ({
          durationMs: output.latencyMs,
          budgetMs: 100,
        }),
      }),
    ],
  }
}

/** Fake target: echoes the expected text for hello/world, wrong text for slow,
 *  and blows the latency budget for the "slow" case. */
async function fakeTarget(input: { prompt: string }): Promise<Answer> {
  const table: Record<string, Answer> = {
    hi: { text: "hello", latencyMs: 10 },
    wo: { text: "world", latencyMs: 20 },
    sl: { text: "SLOW-WRONG", latencyMs: 500 },
  }
  return table[input.prompt] ?? { text: "", latencyMs: 0 }
}

describe("runEval", () => {
  it("aggregates passedCount and meanValue and reports a failing case", async () => {
    const suite = buildSuite()
    const report = await runEval(suite, {
      target: fakeTarget,
      runId: "run-1",
    })

    expect(report.runId).toBe("run-1")
    expect(report.suiteId).toBe("greeting-suite")
    expect(report.total).toBe(3)
    // hello + world pass both scorers; slow fails both.
    expect(report.passedCount).toBe(2)

    const byId = new Map(report.cases.map((c) => [c.caseId, c]))
    expect(byId.get("hello")?.passed).toBe(true)
    expect(byId.get("world")?.passed).toBe(true)
    expect(byId.get("slow")?.passed).toBe(false)

    // slow: exact-match 0, latency partial (500ms vs 100ms budget → 0).
    const slow = byId.get("slow")
    const exact = slow?.scores.find((s) => s.scorerId === "exact")
    expect(exact?.score.passed).toBe(false)
    expect(exact?.score.value).toBe(0)

    // meanValue: 4 perfect 1s (hello×2, world×2) + 2 zeros (slow) over 6 = 4/6.
    expect(report.meanValue).toBeCloseTo(4 / 6, 10)
  })

  it("emits eval.started … eval.finished through a Telemetry<EvalEvent> sink", async () => {
    const sink = arrayTelemetry<EvalEvent>()
    const suite = buildSuite()
    await runEval(suite, { target: fakeTarget, telemetry: sink, runId: "run-2" })

    const kinds = sink.events.map((e) => e.kind)
    expect(kinds[0]).toBe("eval.started")
    expect(kinds[kinds.length - 1]).toBe("eval.finished")

    // Every event carries the runId.
    expect(sink.events.every((e) => e.runId === "run-2")).toBe(true)

    // One started + finished per case, in order.
    const started = sink.events.filter((e) => e.kind === "eval.case.started")
    const finished = sink.events.filter((e) => e.kind === "eval.case.finished")
    expect(started.map((e) => (e.kind === "eval.case.started" ? e.caseId : ""))).toEqual([
      "hello",
      "world",
      "slow",
    ])
    expect(finished).toHaveLength(3)

    // eval.started carries the right counts.
    const startEvent = sink.events[0]
    if (startEvent?.kind === "eval.started") {
      expect(startEvent.caseCount).toBe(3)
      expect(startEvent.scorerCount).toBe(2)
    } else {
      throw new Error("expected eval.started first")
    }

    // eval.finished mirrors the report aggregate.
    const endEvent = sink.events[sink.events.length - 1]
    if (endEvent?.kind === "eval.finished") {
      expect(endEvent.passedCount).toBe(2)
      expect(endEvent.total).toBe(3)
    } else {
      throw new Error("expected eval.finished last")
    }
  })

  it("derives a deterministic runId when none is supplied", async () => {
    const suite = buildSuite()
    const report = await runEval(suite, { target: fakeTarget })
    expect(report.runId.startsWith("greeting-suite#")).toBe(true)
  })
})
