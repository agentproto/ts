import { describe, expect, it } from "vitest"
import type { EvalEvent } from "@agentproto/eval"
import { langfuseTelemetry } from "../langfuse.js"

describe("langfuseTelemetry", () => {
  const cfg = {
    publicKey: "pk-test",
    secretKey: "sk-test",
    baseUrl: "https://cloud.langfuse.com",
    environment: "test-env",
  }

  function makeFetch() {
    const calls: {
      readonly url: string
      readonly init: RequestInit
    }[] = []
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ successes: calls.length }), { status: 207 })
    }
    return { calls, fetchImpl }
  }

  function base64Auth(user: string, pass: string): string {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`
  }

  it("buffers and flushes a trace-create + score-create batch", async () => {
    const { calls, fetchImpl } = makeFetch()
    const sink = langfuseTelemetry({ ...cfg, fetchImpl })

    const started: EvalEvent = {
      kind: "eval.started",
      runId: "run-1",
      at: "2026-01-01T00:00:00.000Z",
      suiteId: "suite-a",
      caseCount: 2,
      scorerCount: 3,
    }
    const scored: EvalEvent = {
      kind: "eval.case.scored",
      runId: "run-1",
      at: "2026-01-01T00:00:01.000Z",
      caseId: "case-1",
      scorerId: "exact-match",
      value: 1,
      passed: true,
    }
    const finished: EvalEvent = {
      kind: "eval.finished",
      runId: "run-1",
      at: "2026-01-01T00:00:02.000Z",
      suiteId: "suite-a",
      total: 2,
      passedCount: 1,
      meanValue: 0.75,
      durationMs: 100,
    }

    sink.emit(started)
    sink.emit(scored)
    sink.emit(finished)

    const result = await sink.flush()

    expect(result.status).toBe(207)
    expect(result.sent).toBe(4)
    expect(result.body).toEqual({ successes: 1 })
    expect(calls).toHaveLength(1)

    const call = calls[0]
    if (call === undefined) throw new Error("expected one fetch call")
    expect(call.url).toBe("https://cloud.langfuse.com/api/public/ingestion")
    expect(call.init.method).toBe("POST")
    expect(call.init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: base64Auth(cfg.publicKey, cfg.secretKey),
    })

    if (typeof call.init.body !== "string") throw new Error("expected string body")
    const body = JSON.parse(call.init.body)
    expect(body.batch).toHaveLength(4)

    const [trace, score, meanScore, passRateScore] = body.batch
    expect(trace).toEqual({
      id: started.runId,
      type: "trace-create",
      timestamp: started.at,
      body: {
        id: started.runId,
        name: `eval:${started.suiteId}`,
        timestamp: started.at,
        environment: cfg.environment,
        metadata: { caseCount: 2, scorerCount: 3 },
      },
    })
    expect(score).toEqual({
      id: `${scored.runId}:${scored.caseId}:${scored.scorerId}`,
      type: "score-create",
      timestamp: scored.at,
      body: {
        id: `${scored.runId}:${scored.caseId}:${scored.scorerId}`,
        traceId: scored.runId,
        name: scored.scorerId,
        value: scored.value,
        dataType: "NUMERIC",
        comment: `case=${scored.caseId} passed=${scored.passed}`,
        timestamp: scored.at,
        environment: cfg.environment,
      },
    })
    expect(meanScore).toEqual({
      id: `${finished.runId}:eval.meanValue`,
      type: "score-create",
      timestamp: finished.at,
      body: {
        id: `${finished.runId}:eval.meanValue`,
        traceId: finished.runId,
        name: "eval.meanValue",
        value: finished.meanValue,
        dataType: "NUMERIC",
        timestamp: finished.at,
        environment: cfg.environment,
      },
    })
    expect(passRateScore).toEqual({
      id: `${finished.runId}:eval.passRate`,
      type: "score-create",
      timestamp: finished.at,
      body: {
        id: `${finished.runId}:eval.passRate`,
        traceId: finished.runId,
        name: "eval.passRate",
        value: finished.passedCount / finished.total,
        dataType: "NUMERIC",
        timestamp: finished.at,
        environment: cfg.environment,
      },
    })
  })

  it("emits only one trace-create per runId", async () => {
    const { fetchImpl } = makeFetch()
    const sink = langfuseTelemetry({ ...cfg, fetchImpl })

    const started: EvalEvent = {
      kind: "eval.started",
      runId: "run-1",
      at: "2026-01-01T00:00:00.000Z",
      suiteId: "suite-a",
      caseCount: 1,
      scorerCount: 1,
    }

    sink.emit(started)
    sink.emit(started)

    const result = await sink.flush()
    expect(result.sent).toBe(1)
  })

  it("ignores unknown event kinds", async () => {
    const { fetchImpl } = makeFetch()
    const sink = langfuseTelemetry({ ...cfg, fetchImpl })

    const unknown = {
      kind: "eval.custom.future",
      runId: "run-1",
      at: "2026-01-01T00:00:00.000Z",
    }
    // @ts-expect-error testing forward-compat with a future event kind
    sink.emit(unknown)
    const result = await sink.flush()
    expect(result.sent).toBe(0)
  })

  it("handles non-JSON response bodies", async () => {
    const { calls, fetchImpl } = makeFetch()
    const fetchText = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response("accepted", { status: 202 })
    }
    const sink = langfuseTelemetry({ ...cfg, fetchImpl: fetchText })

    const started: EvalEvent = {
      kind: "eval.started",
      runId: "run-2",
      at: "2026-01-01T00:00:00.000Z",
      suiteId: "suite-b",
      caseCount: 1,
      scorerCount: 1,
    }
    sink.emit(started)

    const result = await sink.flush()
    expect(result.status).toBe(202)
    expect(result.body).toBe("accepted")
  })

  it("omits environment when not configured", async () => {
    const { calls, fetchImpl } = makeFetch()
    const sink = langfuseTelemetry({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
      fetchImpl,
    })

    const started: EvalEvent = {
      kind: "eval.started",
      runId: "run-3",
      at: "2026-01-01T00:00:00.000Z",
      suiteId: "suite-c",
      caseCount: 1,
      scorerCount: 1,
    }
    sink.emit(started)
    await sink.flush()

    const call = calls[0]
    if (call === undefined) throw new Error("expected one fetch call")
    if (typeof call.init.body !== "string") throw new Error("expected string body")
    const body = JSON.parse(call.init.body)
    expect(body.batch[0].body).not.toHaveProperty("environment")
  })
})
