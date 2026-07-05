/**
 * Dependency-free Langfuse ingestion REST API sink.
 *
 * Maps the agentproto {@link EvalEvent} stream into Langfuse `trace-create`
 * and `score-create` objects and batches them for the public ingestion
 * endpoint (`POST /api/public/ingestion`). No Langfuse SDK is used.
 */

import type { EvalEvent } from "@agentproto/eval"
import type { Telemetry } from "@agentproto/telemetry"
import { createIngestionClient, type FlushResult } from "./ingestion.js"

export type { FlushResult } from "./ingestion.js"

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

/** Public type of the sink returned by {@link langfuseTelemetry}. */
export type LangfuseTelemetrySink = Telemetry<EvalEvent> & {
  flush(): Promise<FlushResult>
}

/** A JSON-serializable value — Langfuse `input`/`output`/`metadata` payloads. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]

type TraceCreateBody = {
  readonly id: string
  readonly name: string
  readonly timestamp: string
  readonly environment?: string
  /** Suite descriptor, set on `eval.started`. */
  readonly input?: JsonValue
  /** Aggregate result, upserted on `eval.finished`. */
  readonly output?: JsonValue
  readonly metadata?: {
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
  /** Nests per-case scores under their case span (see {@link SpanCreateBody}). */
  readonly observationId?: string
  readonly timestamp: string
  readonly environment?: string
}

type SpanCreateBody = {
  readonly id: string
  readonly traceId: string
  readonly name: string
  readonly startTime: string
  readonly input?: JsonValue
  readonly environment?: string
}

type SpanUpdateBody = {
  readonly id: string
  readonly traceId: string
  readonly endTime: string
  readonly output?: JsonValue
  readonly environment?: string
}

// Envelope ids are derived `${bodyId}#${operation}` (see the push helpers): a
// unique string per operation so Langfuse's dedup doesn't collapse a create and
// a later upsert/update of the same object. Items are transported by
// `createIngestionClient` (see ./ingestion.ts).

/**
 * Build a Langfuse ingestion sink for {@link EvalEvent}s.
 *
 * `emit()` buffers events into a batch. `flush()` POSTs the batch to
 * `${cfg.baseUrl}/api/public/ingestion` with Basic auth and returns the
 * HTTP status plus parsed response body.
 */
export function langfuseTelemetry(cfg: LangfuseTelemetryConfig): LangfuseTelemetrySink {
  const client = createIngestionClient(cfg)
  const tracedRuns = new Set<string>()

  /** Stable observation id for a case's span (scores nest under it). */
  const caseSpanId = (runId: string, caseId: string): string => `${runId}:case:${caseId}`

  /** Add the optional `environment` label to any body without an `as` cast. */
  function withEnv<T extends { readonly environment?: string }>(body: T): T {
    if (cfg.environment !== undefined) return { ...body, environment: cfg.environment }
    return body
  }

  function pushTrace(op: string, timestamp: string, body: TraceCreateBody): void {
    client.enqueue({ id: `${body.id}#${op}`, type: "trace-create", timestamp, body: withEnv(body) })
  }

  function pushScore(timestamp: string, body: ScoreCreateBody): void {
    client.enqueue({ id: `${body.id}#score`, type: "score-create", timestamp, body: withEnv(body) })
  }

  function pushSpanCreate(timestamp: string, body: SpanCreateBody): void {
    client.enqueue({ id: `${body.id}#span-create`, type: "span-create", timestamp, body: withEnv(body) })
  }

  function pushSpanUpdate(timestamp: string, body: SpanUpdateBody): void {
    client.enqueue({ id: `${body.id}#span-update`, type: "span-update", timestamp, body: withEnv(body) })
  }

  return {
    emit(event: EvalEvent): void {
      switch (event.kind) {
        case "eval.started": {
          if (tracedRuns.has(event.runId)) return
          tracedRuns.add(event.runId)
          pushTrace("create", event.at, {
            id: event.runId,
            name: `eval:${event.suiteId}`,
            timestamp: event.at,
            input: {
              suiteId: event.suiteId,
              caseCount: event.caseCount,
              scorerCount: event.scorerCount,
            },
            metadata: {
              caseCount: event.caseCount,
              scorerCount: event.scorerCount,
            },
          })
          break
        }
        case "eval.case.started": {
          // Open a per-case span so the trace has a nested tree and each case's
          // scores hang under their own observation.
          pushSpanCreate(event.at, {
            id: caseSpanId(event.runId, event.caseId),
            traceId: event.runId,
            name: `case:${event.caseId}`,
            startTime: event.at,
            input: { caseId: event.caseId },
          })
          break
        }
        case "eval.case.scored": {
          pushScore(event.at, {
            id: `${event.runId}:${event.caseId}:${event.scorerId}`,
            traceId: event.runId,
            name: event.scorerId,
            value: event.value,
            dataType: "NUMERIC",
            comment: `case=${event.caseId} passed=${event.passed}`,
            observationId: caseSpanId(event.runId, event.caseId),
            timestamp: event.at,
          })
          break
        }
        case "eval.case.finished": {
          // Close the case span with its pass/fail outcome.
          pushSpanUpdate(event.at, {
            id: caseSpanId(event.runId, event.caseId),
            traceId: event.runId,
            endTime: event.at,
            output: { passed: event.passed },
          })
          break
        }
        case "eval.finished": {
          const passRate = event.total > 0 ? event.passedCount / event.total : 0
          // Upsert the trace with its aggregate outcome (same body id, distinct
          // envelope op so it is not deduped against the `create`).
          pushTrace("output", event.at, {
            id: event.runId,
            name: `eval:${event.suiteId}`,
            timestamp: event.at,
            output: {
              total: event.total,
              passedCount: event.passedCount,
              failedCount: event.total - event.passedCount,
              meanValue: event.meanValue,
              passRate,
              durationMs: event.durationMs,
            },
          })
          for (const name of ["eval.meanValue", "eval.passRate"] as const) {
            const value = name === "eval.meanValue" ? event.meanValue : passRate
            pushScore(event.at, {
              id: `${event.runId}:${name}`,
              traceId: event.runId,
              name,
              value,
              dataType: "NUMERIC",
              timestamp: event.at,
            })
          }
          break
        }
        default: {
          // Forward-compat: ignore unknown event kinds.
          const _exhaustive: never = event
          void _exhaustive
        }
      }
    },

    flush(): Promise<FlushResult> {
      return client.flush()
    },
  }
}
