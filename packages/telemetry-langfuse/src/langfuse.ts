/**
 * Dependency-free Langfuse ingestion REST API sink.
 *
 * Maps the agentproto {@link EvalEvent} stream into Langfuse `trace-create`
 * and `score-create` objects and batches them for the public ingestion
 * endpoint (`POST /api/public/ingestion`). No Langfuse SDK is used.
 */

import type { EvalEvent } from "@agentproto/eval"
import type { Telemetry } from "@agentproto/telemetry"

/** Configuration for the Langfuse telemetry sink. */
export interface LangfuseTelemetryConfig {
  /** Langfuse public key (used as the Basic auth username). */
  readonly publicKey: string
  /** Langfuse secret key (used as the Basic auth password). */
  readonly secretKey: string
  /** Langfuse base URL, e.g. `https://cloud.langfuse.com`. */
  readonly baseUrl: string
  /** Optional environment label forwarded to Langfuse objects. */
  readonly environment?: string
  /** Optional fetch implementation (defaults to `globalThis.fetch`). */
  readonly fetchImpl?: typeof fetch
}

/** Result returned by {@link LangfuseTelemetrySink.flush}. */
export interface FlushResult {
  readonly status: number
  readonly sent: number
  readonly body: unknown
}

/** Public type of the sink returned by {@link langfuseTelemetry}. */
export type LangfuseTelemetrySink = Telemetry<EvalEvent> & {
  flush(): Promise<FlushResult>
}

type TraceCreateBody = {
  readonly id: string
  readonly name: string
  readonly timestamp: string
  readonly environment?: string
  readonly metadata: {
    readonly caseCount: number
    readonly scorerCount: number
  }
}

type ScoreCreateBody = {
  readonly id: string
  readonly traceId: string
  readonly name: string
  readonly value: number
  readonly dataType: "NUMERIC"
  readonly comment?: string
  readonly timestamp: string
  readonly environment?: string
}

type BatchItem =
  | {
      readonly id: number
      readonly type: "trace-create"
      readonly timestamp: string
      readonly body: TraceCreateBody
    }
  | {
      readonly id: number
      readonly type: "score-create"
      readonly timestamp: string
      readonly body: ScoreCreateBody
    }

/**
 * Build a Langfuse ingestion sink for {@link EvalEvent}s.
 *
 * `emit()` buffers events into a batch. `flush()` POSTs the batch to
 * `${cfg.baseUrl}/api/public/ingestion` with Basic auth and returns the
 * HTTP status plus parsed response body.
 */
export function langfuseTelemetry(cfg: LangfuseTelemetryConfig): LangfuseTelemetrySink {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch
  const auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`
  const batch: BatchItem[] = []
  let nextId = 1
  const tracedRuns = new Set<string>()

  function pushTrace(timestamp: string, body: TraceCreateBody): void {
    batch.push({ id: nextId++, type: "trace-create", timestamp, body })
  }

  function pushScore(timestamp: string, body: ScoreCreateBody): void {
    batch.push({ id: nextId++, type: "score-create", timestamp, body })
  }

  function withEnvironment(body: TraceCreateBody): TraceCreateBody
  function withEnvironment(body: ScoreCreateBody): ScoreCreateBody
  function withEnvironment(
    body: TraceCreateBody | ScoreCreateBody,
  ): TraceCreateBody | ScoreCreateBody {
    if (cfg.environment !== undefined) {
      return { ...body, environment: cfg.environment }
    }
    return body
  }

  return {
    emit(event: EvalEvent): void {
      switch (event.kind) {
        case "eval.started": {
          if (tracedRuns.has(event.runId)) return
          tracedRuns.add(event.runId)
          pushTrace(
            event.at,
            withEnvironment({
              id: event.runId,
              name: `eval:${event.suiteId}`,
              timestamp: event.at,
              metadata: {
                caseCount: event.caseCount,
                scorerCount: event.scorerCount,
              },
            }),
          )
          break
        }
        case "eval.case.scored": {
          pushScore(
            event.at,
            withEnvironment({
              id: `${event.runId}:${event.caseId}:${event.scorerId}`,
              traceId: event.runId,
              name: event.scorerId,
              value: event.value,
              dataType: "NUMERIC",
              comment: `case=${event.caseId} passed=${event.passed}`,
              timestamp: event.at,
            }),
          )
          break
        }
        case "eval.finished": {
          const passRate = event.total > 0 ? event.passedCount / event.total : 0
          for (const name of ["eval.meanValue", "eval.passRate"] as const) {
            const value = name === "eval.meanValue" ? event.meanValue : passRate
            pushScore(
              event.at,
              withEnvironment({
                id: `${event.runId}:${name}`,
                traceId: event.runId,
                name,
                value,
                dataType: "NUMERIC",
                timestamp: event.at,
              }),
            )
          }
          break
        }
        case "eval.case.started":
        case "eval.case.finished":
          // Intentionally not mapped to Langfuse objects.
          break
        default: {
          // Forward-compat: ignore unknown event kinds.
          const _exhaustive: never = event
          void _exhaustive
        }
      }
    },

    async flush(): Promise<FlushResult> {
      const sent = batch.length
      const payload = { batch: batch.slice() }
      const url = `${cfg.baseUrl}/api/public/ingestion`
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify(payload),
      })

      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }

      batch.length = 0
      return { status: response.status, sent, body }
    },
  }
}
