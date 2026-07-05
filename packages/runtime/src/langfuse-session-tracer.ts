/**
 * Langfuse agent-session tracer — a {@link SessionObserver} that projects the
 * per-session stream (prompt in, text/tool/usage events, turn boundaries) into
 * Langfuse traces + generations + tool spans, with native token/cost. It is the
 * SAME tap the transcript writer sits on, so ALL adapters (they converge on the
 * ACP stream) are covered from one place — no per-adapter instrumentation, and
 * the metadata telemetry port stays untouched.
 *
 * Every outbound payload (prompt, assistant text, tool args/results) is passed
 * through a resolved {@link Redactor} at the egress boundary — off by default at
 * the call site (the tracer is only attached when a session opts in), and
 * additionally scrubbable here.
 *
 * Mapping:
 *   recordPrompt        → open the trace once (input = prompt) + a generation for the turn
 *   recordEvent text-delta   → accumulate the generation's output
 *   recordEvent tool-call    → span-create (input = tool args), nested under the generation
 *   recordEvent tool-result  → span-update (output = result, ERROR level on failure)
 *   recordEvent usage_update → stash tokens/cost onto the open generation
 *   recordEvent turn-end     → close the generation (output, usageDetails, costDetails) + flush
 *   recordEvent error        → ERROR on the generation (or a trace event)
 *   recordUsageSnapshot      → authoritative cost/tokens onto the turn's generation
 *   close                    → finalize the trace + flush
 */

import {
  createIngestionClient,
  type FlushResult,
  type IngestionClient,
} from "@agentproto/telemetry-langfuse"
import {
  resolveRedactor,
  type JsonValue,
  type Redactor,
  type RedactionField,
  type RedactorSpec,
} from "@agentproto/redaction"

import type { SessionObserver } from "./session-observer.js"
import type { AgentStreamEvent } from "./sessions.js"
import type { SessionUsage } from "./usage.js"

/** Configuration for {@link langfuseSessionTracer}. */
export interface LangfuseSessionTracerConfig {
  readonly publicKey: string
  readonly secretKey: string
  readonly baseUrl: string
  /** Environment label stamped on every Langfuse object (e.g. a guild id). */
  readonly environment?: string
  /** Redactor spec applied to every outbound payload. Default: `"none"`. */
  readonly redactor?: RedactorSpec
  /** Optional fetch implementation (defaults to `globalThis.fetch`). */
  readonly fetchImpl?: typeof fetch
  /** Optional clock (ISO string). Defaults to real time. */
  readonly now?: () => string
}

/** A session tracer sink — a {@link SessionObserver} with a manual `flush`. */
export interface LangfuseSessionTracer extends SessionObserver {
  flush(): Promise<FlushResult>
}

/** Per-turn generation state. */
interface GenerationState {
  readonly id: string
  output: string
  open: boolean
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  model?: string
}

/** Per-session trace state. */
interface TraceState {
  traceOpened: boolean
  turnIndex: number
  /** The most recent turn's generation (kept after close so a late usage
   *  snapshot can still attach cost to it). */
  generation: GenerationState | null
}

/**
 * Coerce an arbitrary value (ACP `arguments`/`result`/prompt are typed
 * `unknown`) into a {@link JsonValue} the redactor can walk — deep, total, and
 * cast-free. Non-JSON leaves (bigint, function, symbol, undefined, non-finite
 * numbers) degrade to their string form rather than being dropped.
 */
function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : String(value)
    case "object": {
      if (Array.isArray(value)) return value.map(toJsonValue)
      const out: { [key: string]: JsonValue } = {}
      for (const [key, entryValue] of Object.entries(value)) {
        out[key] = toJsonValue(entryValue)
      }
      return out
    }
    default:
      return String(value)
  }
}

export function langfuseSessionTracer(
  cfg: LangfuseSessionTracerConfig,
): LangfuseSessionTracer {
  const client: IngestionClient = createIngestionClient(cfg)
  const redactor: Redactor = resolveRedactor(cfg.redactor)
  const clock = cfg.now ?? (() => new Date().toISOString())
  const states = new Map<string, TraceState>()

  const redact = (value: unknown, field: RedactionField, sessionId: string): JsonValue =>
    redactor.redact(toJsonValue(value), { field, sessionId })

  const withEnv = <T extends object>(body: T): T =>
    cfg.environment !== undefined ? { ...body, environment: cfg.environment } : body

  const getState = (sessionId: string): TraceState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { traceOpened: false, turnIndex: 0, generation: null }
      states.set(sessionId, state)
    }
    return state
  }

  /** Fire-and-forget flush from a sync observer method — never throws a turn. */
  const flushSoon = (): void => {
    void client.flush().catch(() => {
      // isolate: a Langfuse outage must never break the session loop
    })
  }

  return {
    recordPrompt(sessionId: string, message: unknown): void {
      const state = getState(sessionId)
      const at = clock()
      const input = redact(message, "prompt", sessionId)
      if (!state.traceOpened) {
        state.traceOpened = true
        client.enqueue({
          id: `${sessionId}#trace-create`,
          type: "trace-create",
          timestamp: at,
          body: withEnv({
            id: sessionId,
            name: "agent-session",
            timestamp: at,
            input,
          }),
        })
      }
      state.turnIndex += 1
      const genId = `${sessionId}:turn:${state.turnIndex}`
      state.generation = { id: genId, output: "", open: true }
      client.enqueue({
        id: `${genId}#gen-create`,
        type: "generation-create",
        timestamp: at,
        body: withEnv({
          id: genId,
          traceId: sessionId,
          name: `turn:${state.turnIndex}`,
          startTime: at,
          input,
        }),
      })
    },

    recordEvent(sessionId: string, evt: AgentStreamEvent): void {
      const state = getState(sessionId)
      const gen = state.generation
      const at = clock()
      switch (evt.kind) {
        case "text-delta": {
          if (gen?.open && typeof evt.text === "string") gen.output += evt.text
          return
        }
        case "tool-call": {
          if (evt.toolCallId === undefined) return
          client.enqueue({
            id: `${sessionId}:tool:${evt.toolCallId}#span-create`,
            type: "span-create",
            timestamp: at,
            body: withEnv({
              id: `${sessionId}:tool:${evt.toolCallId}`,
              traceId: sessionId,
              ...(gen ? { parentObservationId: gen.id } : {}),
              name: typeof evt.toolName === "string" ? evt.toolName : "tool",
              startTime: at,
              input: redact(evt.arguments, "tool-args", sessionId),
            }),
          })
          return
        }
        case "tool-result": {
          if (evt.toolCallId === undefined) return
          client.enqueue({
            id: `${sessionId}:tool:${evt.toolCallId}#span-update`,
            type: "span-update",
            timestamp: at,
            body: withEnv({
              id: `${sessionId}:tool:${evt.toolCallId}`,
              traceId: sessionId,
              endTime: at,
              output: redact(evt.result, "tool-result", sessionId),
              ...(evt.isError === true ? { level: "ERROR" } : {}),
            }),
          })
          return
        }
        case "usage_update": {
          if (!gen) return
          if (typeof evt.tokensIn === "number") gen.tokensIn = evt.tokensIn
          if (typeof evt.tokensOut === "number") gen.tokensOut = evt.tokensOut
          if (evt.cost && typeof evt.cost.amount === "number") gen.costUsd = evt.cost.amount
          return
        }
        case "turn-end": {
          if (gen?.open) {
            gen.open = false
            client.enqueue({
              id: `${gen.id}#gen-update`,
              type: "generation-update",
              timestamp: at,
              body: withEnv({
                id: gen.id,
                traceId: sessionId,
                endTime: at,
                output: redact(gen.output, "output", sessionId),
                ...(gen.tokensIn !== undefined || gen.tokensOut !== undefined
                  ? { usageDetails: { input: gen.tokensIn ?? 0, output: gen.tokensOut ?? 0 } }
                  : {}),
                ...(gen.costUsd !== undefined ? { costDetails: { total: gen.costUsd } } : {}),
              }),
            })
          }
          flushSoon()
          return
        }
        case "error": {
          const message = evt.error?.message ?? "error"
          if (gen) {
            client.enqueue({
              id: `${gen.id}#gen-error`,
              type: "generation-update",
              timestamp: at,
              body: withEnv({
                id: gen.id,
                traceId: sessionId,
                level: "ERROR",
                statusMessage: message,
              }),
            })
          }
          return
        }
        default:
          return
      }
    },

    recordUsageSnapshot(sessionId: string, usage: SessionUsage): void {
      const state = states.get(sessionId)
      const gen = state?.generation
      if (!gen) return
      const at = clock()
      // Authoritative cost/tokens from the runtime's own pricing (usage.ts) —
      // merged onto the turn's generation so Langfuse cost == the billing ledger.
      const hasTokens = usage.tokensIn !== undefined || usage.tokensOut !== undefined
      if (usage.costUsd === undefined && !hasTokens && usage.model === undefined) return
      client.enqueue({
        id: `${gen.id}#gen-usage`,
        type: "generation-update",
        timestamp: at,
        body: withEnv({
          id: gen.id,
          traceId: sessionId,
          ...(usage.model !== undefined ? { model: usage.model } : {}),
          ...(hasTokens
            ? { usageDetails: { input: usage.tokensIn ?? 0, output: usage.tokensOut ?? 0 } }
            : {}),
          ...(usage.costUsd !== undefined ? { costDetails: { total: usage.costUsd } } : {}),
        }),
      })
    },

    async close(sessionId: string): Promise<void> {
      const state = states.get(sessionId)
      if (state?.traceOpened) {
        const at = clock()
        client.enqueue({
          id: `${sessionId}#trace-output`,
          type: "trace-create",
          timestamp: at,
          body: withEnv({
            id: sessionId,
            name: "agent-session",
            timestamp: at,
            output: { turns: state.turnIndex },
          }),
        })
      }
      states.delete(sessionId)
      await client.flush()
    },

    async closeAll(): Promise<void> {
      states.clear()
      await client.flush()
    },

    flush(): Promise<FlushResult> {
      return client.flush()
    },
  }
}
