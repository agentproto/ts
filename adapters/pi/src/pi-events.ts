/**
 * Pi RPC wire types + the pure pi-event → {@link StreamEvent} mapper.
 *
 * Pi (`@earendil-works/pi-coding-agent`) exposes a persistent
 * JSON-over-stdio RPC mode (`pi --mode rpc`). Its stdout carries two
 * kinds of LF-delimited JSON records:
 *
 *   1. **Responses** — `{ type: "response", command, success, id?, data?, error? }`,
 *      correlated to a command by the `id` echoed back. Handled by the
 *      client's request/response layer.
 *   2. **Session events** — the `AgentSessionEvent` union emitted by pi's
 *      `session.subscribe(...)` (assistant text/thinking deltas, tool
 *      execution lifecycle, turn/agent lifecycle). These are what this
 *      module narrows and maps onto agentproto's canonical taxonomy.
 *
 * Everything here is pure and synchronous so it can be unit-tested
 * against hand-built pi records without spawning a real `pi`.
 *
 * Wire profile documented in ../PI-RPC.md.
 */

import type { StreamEvent } from "@agentproto/driver-agent-cli"

// ============================================================================
// Pi wire types (the subset this adapter reads — mirrors pi source, no `any`)
// ============================================================================

/** Pi `StopReason` (packages/ai/src/types.ts). */
export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted"

/** Pi `Usage` (packages/ai/src/types.ts) — token + cost accounting on an
 *  assistant message. Only the fields this adapter surfaces are modelled. */
export interface PiUsage {
  input: number
  output: number
  totalTokens: number
  cost: { total: number }
}

/** Minimal shape of an assistant `AgentMessage` carried on `turn_end`. */
export interface PiTurnMessage {
  role: string
  stopReason?: PiStopReason
  usage?: PiUsage
  errorMessage?: string
}

/** Assistant-message-event types this adapter does NOT translate but must
 *  still discriminate cleanly (keeps `PiAssistantMessageEvent` exhaustive). */
export type PiIgnoredAssistantEventType =
  | "start"
  | "text_start"
  | "text_end"
  | "thinking_start"
  | "thinking_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end"

/** Pi `AssistantMessageEvent` (packages/ai/src/types.ts), narrowed to the
 *  fields this adapter reads. Streaming deltas + the terminal done/error. */
export type PiAssistantMessageEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: "error" | "aborted"; errorMessage?: string }
  | { type: PiIgnoredAssistantEventType }

/** Pi `AgentSessionEvent` (packages/coding-agent/src/core/agent-session.ts +
 *  packages/agent/src/types.ts `AgentEvent`), narrowed to the events this
 *  adapter acts on. Any other pi event is dropped before it reaches here. */
export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: PiTurnMessage }
  | { type: "message_update"; assistantMessageEvent: PiAssistantMessageEvent }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_end"
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
    }
  | { type: "agent_settled" }

/** A pi RPC response line (`type: "response"`). */
export interface PiResponse {
  type: "response"
  id?: string
  command: string
  success: boolean
  error?: string
  data?: unknown
}

/** Classified pi stdout line. `other` covers extension-UI requests, the
 *  json-mode session header, and anything this adapter ignores. */
export type PiOutbound =
  | { kind: "response"; response: PiResponse }
  | { kind: "event"; event: PiSessionEvent }
  | { kind: "other" }

// ============================================================================
// Narrowing helpers (unknown → typed, no `as` casts)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asStopReason(value: unknown): PiStopReason | undefined {
  return value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
    ? value
    : undefined
}

function narrowUsage(value: unknown): PiUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.input)
  const output = asNumber(value.output)
  const totalTokens = asNumber(value.totalTokens)
  const cost = isRecord(value.cost) ? asNumber(value.cost.total) : undefined
  if (
    input === undefined ||
    output === undefined ||
    totalTokens === undefined ||
    cost === undefined
  ) {
    return undefined
  }
  return { input, output, totalTokens, cost: { total: cost } }
}

function narrowTurnMessage(value: unknown): PiTurnMessage | undefined {
  if (!isRecord(value)) return undefined
  const role = asString(value.role)
  if (role === undefined) return undefined
  return {
    role,
    stopReason: asStopReason(value.stopReason),
    usage: narrowUsage(value.usage),
    errorMessage: asString(value.errorMessage),
  }
}

function narrowAssistantMessageEvent(
  value: unknown,
): PiAssistantMessageEvent | undefined {
  if (!isRecord(value)) return undefined
  const type = asString(value.type)
  switch (type) {
    case "text_delta": {
      const delta = asString(value.delta)
      return delta === undefined ? undefined : { type, delta }
    }
    case "thinking_delta": {
      const delta = asString(value.delta)
      return delta === undefined ? undefined : { type, delta }
    }
    case "done": {
      const reason = asString(value.reason)
      return reason === "stop" || reason === "length" || reason === "toolUse"
        ? { type, reason }
        : undefined
    }
    case "error": {
      const reason = asString(value.reason)
      if (reason !== "error" && reason !== "aborted") return undefined
      return { type, reason, errorMessage: asString(value.errorMessage) }
    }
    case "start":
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return { type }
    default:
      return undefined
  }
}

function narrowSessionEvent(value: Record<string, unknown>, type: string): PiSessionEvent | undefined {
  switch (type) {
    case "agent_start":
      return { type }
    case "agent_end":
      return { type, willRetry: asBoolean(value.willRetry) }
    case "turn_start":
      return { type }
    case "turn_end":
      return { type, message: narrowTurnMessage(value.message) }
    case "agent_settled":
      return { type }
    case "message_update": {
      const evt = narrowAssistantMessageEvent(value.assistantMessageEvent)
      return evt === undefined ? undefined : { type, assistantMessageEvent: evt }
    }
    case "tool_execution_start": {
      const toolCallId = asString(value.toolCallId)
      const toolName = asString(value.toolName)
      if (toolCallId === undefined || toolName === undefined) return undefined
      return { type, toolCallId, toolName, args: value.args }
    }
    case "tool_execution_end": {
      const toolCallId = asString(value.toolCallId)
      const toolName = asString(value.toolName)
      const isError = asBoolean(value.isError)
      if (toolCallId === undefined || toolName === undefined || isError === undefined) {
        return undefined
      }
      return { type, toolCallId, toolName, result: value.result, isError }
    }
    default:
      return undefined
  }
}

/**
 * Parse + classify one pi stdout JSON line. Returns `{ kind: "other" }` for
 * malformed lines and any record this adapter does not act on, so the caller
 * can uniformly ignore them.
 */
export function classifyPiLine(line: string): PiOutbound {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: "other" }
  }
  if (!isRecord(parsed)) return { kind: "other" }

  const type = asString(parsed.type)
  if (type === undefined) return { kind: "other" }

  if (type === "response") {
    const command = asString(parsed.command)
    const success = asBoolean(parsed.success)
    if (command === undefined || success === undefined) return { kind: "other" }
    return {
      kind: "response",
      response: {
        type: "response",
        id: asString(parsed.id),
        command,
        success,
        error: asString(parsed.error),
        data: parsed.data,
      },
    }
  }

  const event = narrowSessionEvent(parsed, type)
  return event === undefined ? { kind: "other" } : { kind: "event", event }
}

// ============================================================================
// Mapper
// ============================================================================

/** Carried across a turn's events — pi reports the stop reason mid-stream
 *  (`message_update` done/error, `turn_end.message.stopReason`) but the
 *  turn only truly closes on `agent_settled`, so it must be remembered. */
export interface PiMapperState {
  lastStopReason: PiStopReason | undefined
}

export function createPiMapperState(): PiMapperState {
  return { lastStopReason: undefined }
}

/** Reset for a fresh turn (call in the client's `send`). */
export function resetPiMapperState(state: PiMapperState): void {
  state.lastStopReason = undefined
}

/** Map a pi `StopReason` onto the canonical `turn-end` reason.
 *  `length` (token/context cap) has no exact equivalent; `max_turns` is the
 *  closest "hit a budget limit" reason. `toolUse` is never the settled
 *  reason (the loop keeps going) but falls back to `completed` defensively. */
export function mapStopReason(
  reason: PiStopReason | undefined,
): "completed" | "cancelled" | "max_turns" | "error" {
  switch (reason) {
    case "aborted":
      return "cancelled"
    case "error":
      return "error"
    case "length":
      return "max_turns"
    case "stop":
    case "toolUse":
    case undefined:
      return "completed"
  }
}

function usageUpdate(sessionId: string, usage: PiUsage): StreamEvent {
  return {
    kind: "usage_update",
    sessionId,
    // Pi's per-message `Usage` reports token totals but not a context-window
    // size; `totalTokens` is surfaced as both `size` and `used` (documented
    // gap in PI-RPC.md). Cost is pi's own computed USD figure.
    size: usage.totalTokens,
    used: usage.totalTokens,
    cost: { amount: usage.cost.total, currency: "USD" },
    tokensIn: usage.input,
    tokensOut: usage.output,
  }
}

/**
 * Translate one pi session event into zero or more {@link StreamEvent}s,
 * updating `state` in place. Pure aside from the state mutation.
 *
 * `agent_end` (with `willRetry` false) is the turn terminator: it flushes a
 * `turn-end` whose reason reflects the stop reason accumulated over the turn.
 * An `agent_end` with `willRetry: true` (auto-retry) does NOT close the turn —
 * pi will run again and emit a final `agent_end`. NOTE: pi's `agent_settled`
 * event is emitted to in-process extension listeners but is NOT written to the
 * RPC stdout stream (verified empirically against pi 0.80.3), so it cannot be
 * relied on as the terminator — see PI-RPC.md.
 */
export function mapPiEvent(
  event: PiSessionEvent,
  sessionId: string,
  state: PiMapperState,
): StreamEvent[] {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent
      switch (inner.type) {
        case "text_delta":
          return [{ kind: "text-delta", sessionId, text: inner.delta }]
        case "thinking_delta":
          return [{ kind: "thought", sessionId, text: inner.delta }]
        case "done":
          state.lastStopReason = inner.reason
          return []
        case "error":
          state.lastStopReason = inner.reason
          if (inner.reason === "error") {
            return [
              {
                kind: "error",
                sessionId,
                error: { message: inner.errorMessage ?? "pi assistant error" },
              },
            ]
          }
          return []
        default:
          return []
      }
    }
    case "tool_execution_start":
      return [
        {
          kind: "tool-call",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
        },
      ]
    case "tool_execution_end":
      return [
        {
          kind: "tool-result",
          sessionId,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        },
      ]
    case "turn_end": {
      const message = event.message
      if (message?.role === "assistant" && message.stopReason !== undefined) {
        state.lastStopReason = message.stopReason
      }
      if (message?.usage !== undefined) {
        return [usageUpdate(sessionId, message.usage)]
      }
      return []
    }
    case "agent_end":
      // `willRetry: true` = an auto-retry cycle; the turn isn't over. Only a
      // terminal `agent_end` closes the turn.
      if (event.willRetry === true) return []
      return [{ kind: "turn-end", sessionId, reason: mapStopReason(state.lastStopReason) }]
    case "agent_start":
    case "turn_start":
    // `agent_settled` never reaches the RPC stdout stream (see the fn doc); if
    // a future pi build did emit it, the turn is already closed by `agent_end`,
    // so ignoring it here is correct either way.
    case "agent_settled":
      return []
  }
}
