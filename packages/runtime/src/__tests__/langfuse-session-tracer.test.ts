import { describe, expect, it } from "vitest"
import { langfuseSessionTracer } from "../langfuse-session-tracer.js"
import type { AgentStreamEvent } from "../sessions.js"

interface PostedItem {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly body: Record<string, unknown>
}

function makeTracer() {
  const posted: PostedItem[] = []
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init && typeof init.body === "string") {
      const parsed = JSON.parse(init.body)
      for (const item of parsed.batch) posted.push(item)
    }
    return new Response(JSON.stringify({ successes: posted.length }), { status: 207 })
  }
  const tracer = langfuseSessionTracer({
    publicKey: "pk",
    secretKey: "sk",
    baseUrl: "https://lf.example",
    environment: "test",
    redactor: "deny-list",
    fetchImpl,
    now: () => "2026-01-01T00:00:00.000Z",
  })
  const byType = (type: string): PostedItem[] => posted.filter((i) => i.type === type)
  return { tracer, posted, byType }
}

const ev = (e: AgentStreamEvent): AgentStreamEvent => e

describe("langfuseSessionTracer", () => {
  it("maps a full turn to trace + generation + tool span with usage/cost", async () => {
    const { tracer, byType } = makeTracer()

    tracer.recordPrompt("s1", "summarise the doc")
    tracer.recordEvent("s1", ev({ kind: "text-delta", text: "Hello " }))
    tracer.recordEvent("s1", ev({ kind: "text-delta", text: "world" }))
    tracer.recordEvent(
      "s1",
      ev({ kind: "tool-call", toolCallId: "t1", toolName: "http", arguments: { url: "x" } }),
    )
    tracer.recordEvent("s1", ev({ kind: "tool-result", toolCallId: "t1", result: { ok: true } }))
    tracer.recordEvent("s1", ev({ kind: "usage_update", tokensIn: 10, tokensOut: 20, cost: { amount: 0.01, currency: "USD" } }))
    tracer.recordEvent("s1", ev({ kind: "turn-end", reason: "completed" }))
    await tracer.flush()

    const trace = byType("trace-create").find((i) => i.id === "s1#trace-create")
    expect(trace?.body).toMatchObject({ id: "s1", name: "agent-session", input: "summarise the doc", environment: "test" })

    const gen = byType("generation-create").find((i) => i.id === "s1:turn:1#gen-create")
    expect(gen?.body).toMatchObject({ id: "s1:turn:1", traceId: "s1", name: "turn:1", input: "summarise the doc" })

    const span = byType("span-create").find((i) => i.id === "s1:tool:t1#span-create")
    expect(span?.body).toMatchObject({ id: "s1:tool:t1", traceId: "s1", parentObservationId: "s1:turn:1", name: "http", input: { url: "x" } })

    const spanUpd = byType("span-update").find((i) => i.id === "s1:tool:t1#span-update")
    expect(spanUpd?.body).toMatchObject({ id: "s1:tool:t1", output: { ok: true } })

    const genUpd = byType("generation-update").find((i) => i.id === "s1:turn:1#gen-update")
    expect(genUpd?.body).toMatchObject({
      id: "s1:turn:1",
      endTime: "2026-01-01T00:00:00.000Z",
      output: "Hello world",
      usageDetails: { input: 10, output: 20 },
      costDetails: { total: 0.01 },
    })
  })

  it("redacts secrets in tool args at the egress boundary", async () => {
    const { tracer, byType } = makeTracer()
    tracer.recordPrompt("s2", "go")
    tracer.recordEvent(
      "s2",
      ev({
        kind: "tool-call",
        toolCallId: "c1",
        toolName: "fetch",
        arguments: { url: "https://api", authorization: "Bearer sk-super-secret", body: { password: "hunter2" } },
      }),
    )
    await tracer.flush()

    const span = byType("span-create").find((i) => i.id === "s2:tool:c1#span-create")
    expect(span?.body.input).toEqual({
      url: "https://api",
      authorization: "[redacted]",
      body: { password: "[redacted]" },
    })
  })

  it("attaches authoritative cost from the usage snapshot to the turn's generation", async () => {
    const { tracer, byType } = makeTracer()
    tracer.recordPrompt("s3", "hi")
    tracer.recordEvent("s3", ev({ kind: "turn-end", reason: "completed" }))
    await tracer.flush()
    tracer.recordUsageSnapshot("s3", { source: "computed", costUsd: 0.05, tokensIn: 5, tokensOut: 7, model: "claude-x" })
    await tracer.flush()

    const usageUpd = byType("generation-update").find((i) => i.id === "s3:turn:1#gen-usage")
    expect(usageUpd?.body).toMatchObject({
      id: "s3:turn:1",
      model: "claude-x",
      usageDetails: { input: 5, output: 7 },
      costDetails: { total: 0.05 },
    })
  })

  it("marks a generation ERROR on an error event", async () => {
    const { tracer, byType } = makeTracer()
    tracer.recordPrompt("s4", "hi")
    tracer.recordEvent("s4", ev({ kind: "error", error: { message: "boom" } }))
    await tracer.flush()
    const err = byType("generation-update").find((i) => i.id === "s4:turn:1#gen-error")
    expect(err?.body).toMatchObject({ id: "s4:turn:1", level: "ERROR", statusMessage: "boom" })
  })

  it("finalizes the trace output on close and opens the trace only once", async () => {
    const { tracer, byType } = makeTracer()
    tracer.recordPrompt("s5", "one")
    tracer.recordEvent("s5", ev({ kind: "turn-end", reason: "completed" }))
    tracer.recordPrompt("s5", "two")
    tracer.recordEvent("s5", ev({ kind: "turn-end", reason: "completed" }))
    await tracer.close("s5")

    expect(byType("trace-create").filter((i) => i.id === "s5#trace-create")).toHaveLength(1)
    const out = byType("trace-create").find((i) => i.id === "s5#trace-output")
    expect(out?.body).toMatchObject({ id: "s5", output: { turns: 2 } })
    expect(byType("generation-create")).toHaveLength(2)
  })

  it("never throws a turn when the sink is unavailable", async () => {
    const tracer = langfuseSessionTracer({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://lf.example",
      fetchImpl: async () => {
        throw new Error("network down")
      },
      now: () => "2026-01-01T00:00:00.000Z",
    })
    tracer.recordPrompt("s6", "hi")
    expect(() => tracer.recordEvent("s6", ev({ kind: "turn-end", reason: "completed" }))).not.toThrow()
    await expect(tracer.close("s6")).rejects.toThrow() // close awaits, surfaces the error to the caller
  })
})
