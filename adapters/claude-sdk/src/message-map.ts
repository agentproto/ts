/**
 * Pure mapping from the Claude Agent SDK's message stream (`SDKMessage`, the
 * values `query()` yields) to AIP-44 ACP `session/update` payloads. Kept
 * side-effect free and dependency-light (types only) so it is straightforward
 * to unit-test; the ACP host (acp-host.ts) owns the wire/IO and forwards
 * whatever this returns.
 *
 * I/O stays 100% Anthropic-native: we read the SDK's real message shapes and
 * translate them to ACP updates — no format translation of the model I/O.
 *
 * The SDK emits a typed union on `query()`. We surface:
 *   - `stream_event` text delta     → ACP `agent_message_chunk` (streamed prose)
 *   - `stream_event` thinking delta  → ACP `agent_thought_chunk` (streamed reasoning)
 *   - `assistant` text blocks        → ACP `agent_message_chunk` (assistant prose)
 *   - `assistant` tool_use           → ACP `tool_call`        (a tool started)
 *   - `user` tool_result             → ACP `tool_call_update` (that tool finished/failed)
 *   - `result`                       → ACP `usage_update`     (tokens + cost)
 * The `system`/`init` message carries the SDK `session_id`, handled separately
 * by the host (see {@link systemInitSessionId}).
 *
 * With `includePartialMessages` on (see options.ts), assistant prose arrives
 * TWICE: first as streamed `stream_event` text deltas, then again in the
 * terminal complete `assistant` message. The host tracks whether it saw any
 * partial and asks {@link sdkMessageToUpdates} to suppress the complete
 * message's text so the ring isn't double-fed (see `suppressAssistantText`).
 * `thinking` is only ever surfaced via the streamed deltas — the complete
 * `assistant` message's thinking block is intentionally not mapped.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { SessionUpdate, ToolKind, UsageUpdate } from "@agentclientprotocol/sdk"

/**
 * A `usage_update` session update. ACP's `UsageUpdate` models `size`/`used`/
 * `cost`; we widen it with the optional `tokensIn`/`tokensOut` the agentproto
 * runtime also reads (see packages/acp translateSessionUpdate + runtime
 * sessions.ts), so a session whose adapter reports tokens can be priced even
 * without a `cost`. Assignable to `SessionUpdate` structurally (extra fields
 * are allowed), so no cast is needed.
 */
export type UsageSessionUpdate = UsageUpdate & {
  sessionUpdate: "usage_update"
  tokensIn?: number
  tokensOut?: number
}

/** Map a Claude Code built-in tool name to the ACP {@link ToolKind} that
 *  drives client icon/UI treatment. Unknown/MCP tools fall back to "other". */
export function toolKindForClaudeTool(name: string): ToolKind {
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read"
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit"
    case "Bash":
    case "BashOutput":
    case "KillBash":
      return "execute"
    case "Grep":
    case "Glob":
      return "search"
    case "WebFetch":
    case "WebSearch":
      return "fetch"
    case "Task":
      return "think"
    default:
      return "other"
  }
}

/** Read a string-valued property from an unknown value without an unsafe
 *  cast — narrows via `in` and a `typeof` guard. */
function stringField(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object" && key in input) {
    const value: unknown = Reflect.get(input, key)
    if (typeof value === "string") return value
  }
  return undefined
}

/** A short, human-readable title for a tool call, e.g. `Bash: ls -la` or
 *  `Read: src/index.ts`. Falls back to the bare tool name. */
export function toolCallTitle(name: string, input: unknown): string {
  const hint =
    stringField(input, "command") ??
    stringField(input, "file_path") ??
    stringField(input, "path") ??
    stringField(input, "pattern") ??
    stringField(input, "url")
  return hint ? `${name}: ${hint}` : name
}

/** Translate one complete `assistant` message into ACP updates: one per text
 *  block (agent_message_chunk) and one per tool_use block (tool_call).
 *
 *  `suppressText` drops the text blocks — set by the host once it has seen
 *  `stream_event` deltas this turn, since the prose already streamed and
 *  re-emitting the complete copy would double-feed the ring. tool_use blocks
 *  are always emitted (they carry the full input the daemon needs and never
 *  arrive as a usable partial). */
export function assistantMessageUpdates(
  msg: SDKAssistantMessage,
  suppressText = false,
): SessionUpdate[] {
  const updates: SessionUpdate[] = []
  for (const block of msg.message.content) {
    if (block.type === "text") {
      if (suppressText || !block.text) continue
      updates.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: block.text },
      })
    } else if (block.type === "tool_use") {
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: block.id,
        title: toolCallTitle(block.name, block.input),
        kind: toolKindForClaudeTool(block.name),
        status: "in_progress",
        rawInput: block.input,
      })
    }
  }
  return updates
}

/**
 * Translate a `stream_event` (partial-assistant) message into ACP deltas.
 * Only `content_block_delta` text / thinking deltas carry user-visible content:
 *   - `text_delta`     → `agent_message_chunk` (streamed assistant prose)
 *   - `thinking_delta` → `agent_thought_chunk` (streamed extended-thinking)
 * Every other frame (block start/stop, `input_json_delta`, `signature_delta`,
 * message-level `message_start`/`message_delta`/`message_stop`) produces
 * nothing here — but still counts as an SDK message to the host's turn
 * watchdog, which is exactly why partial streaming keeps a long thinking turn
 * from being mistaken for a stall.
 *
 * Read structurally (via typed field guards) rather than importing the beta
 * `RawContentBlockDelta` union — this file stays dependency-light per its
 * header, and the two delta shapes we care about are tiny and stable
 * (`{ type: "text_delta", text }` / `{ type: "thinking_delta", thinking }`).
 */
export function streamEventUpdates(
  msg: SDKPartialAssistantMessage,
): SessionUpdate[] {
  const event: unknown = msg.event
  if (stringField(event, "type") !== "content_block_delta") return []
  const delta =
    event && typeof event === "object" ? Reflect.get(event, "delta") : undefined
  switch (stringField(delta, "type")) {
    case "text_delta": {
      const text = stringField(delta, "text")
      return text
        ? [
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          ]
        : []
    }
    case "thinking_delta": {
      const thinking = stringField(delta, "thinking")
      return thinking
        ? [
            {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: thinking },
            },
          ]
        : []
    }
    default:
      return []
  }
}

/** Translate a `user` message's tool_result blocks into ACP
 *  `tool_call_update`s. Non-tool user echoes (a plain string, or the initial
 *  prompt) produce nothing. */
export function userMessageUpdates(msg: SDKUserMessage): SessionUpdate[] {
  const content = msg.message.content
  if (typeof content === "string") return []
  const updates: SessionUpdate[] = []
  for (const block of content) {
    if (block.type !== "tool_result") continue
    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: block.tool_use_id,
      status: block.is_error ? "failed" : "completed",
      rawOutput: block.content,
    })
  }
  return updates
}

/** The largest reported context-window size across the turn's models, or 0. */
function contextWindowOf(msg: SDKResultMessage): number {
  let size = 0
  for (const usage of Object.values(msg.modelUsage)) {
    if (usage.contextWindow > size) size = usage.contextWindow
  }
  return size
}

/** Translate a `result` message into an ACP `usage_update`. Native Anthropic
 *  usage → the shape the runtime already consumes: `size` (context window),
 *  `used` (tokens in context), `cost` (from `total_cost_usd`), and the
 *  `tokensIn`/`tokensOut` extension. */
export function resultUsageUpdate(msg: SDKResultMessage): UsageSessionUpdate {
  const u = msg.usage
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheCreate = u.cache_creation_input_tokens ?? 0
  const tokensIn = u.input_tokens + cacheRead + cacheCreate
  const tokensOut = u.output_tokens
  return {
    sessionUpdate: "usage_update",
    size: contextWindowOf(msg),
    used: tokensIn + tokensOut,
    cost: { amount: msg.total_cost_usd, currency: "USD" },
    tokensIn,
    tokensOut,
  }
}

/**
 * Dispatch one SDK message to the ACP updates it produces (possibly none).
 * `system`/`init` is intentionally not mapped here — its `session_id` is read
 * by the host via {@link systemInitSessionId}, not surfaced as an update.
 *
 * `suppressAssistantText` is forwarded to {@link assistantMessageUpdates}: the
 * host sets it once a `stream_event` has streamed this turn's prose, so the
 * terminal complete `assistant` message doesn't re-emit the same text.
 */
export function sdkMessageToUpdates(
  msg: SDKMessage,
  opts: { suppressAssistantText?: boolean } = {},
): SessionUpdate[] {
  switch (msg.type) {
    case "stream_event":
      return streamEventUpdates(msg)
    case "assistant":
      return assistantMessageUpdates(msg, opts.suppressAssistantText ?? false)
    case "user":
      return userMessageUpdates(msg)
    case "result":
      return [resultUsageUpdate(msg)]
    default:
      return []
  }
}

/** Extract the SDK `session_id` from the `system`/`init` message, else null. */
export function systemInitSessionId(msg: SDKMessage): string | null {
  if (msg.type === "system" && isInit(msg)) return msg.session_id
  return null
}

/** Narrow a `system` message to its `init` subtype (which carries the
 *  authoritative `session_id` and model). */
function isInit(msg: SDKMessage & { type: "system" }): msg is SDKSystemMessage {
  return msg.subtype === "init"
}
