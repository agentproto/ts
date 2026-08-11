/**
 * Pure mapping from Mastra `AgentController` session events to AIP-44 ACP
 * `session/update` payloads. Kept dependency-light (type-only imports) and
 * IO-free so it is straightforward to unit-test; the ACP host (acp-host.ts)
 * owns the wire and just forwards whatever this returns.
 *
 * A controller session (`session.subscribe`) emits `AgentControllerEvent`s.
 * We surface three kinds:
 *   - `message_update` → ACP `agent_message_chunk` (assistant prose, as a delta)
 *   - `tool_start`     → ACP `tool_call`        (a tool started, status in_progress)
 *   - `tool_end`       → ACP `tool_call_update` (that tool finished: completed/failed)
 * Everything else (message_start/end, tool_input_*, usage, display state,
 * agent_start/end, error, …) has no ACP surface here — `error` and `agent_end`
 * are read by the host to pick the turn's stop reason, not mapped to updates.
 *
 * `message_update` carries the FULL message accumulated so far (Mastra's run
 * engine re-emits the whole `MastraDBMessage` on every text delta), while ACP
 * `agent_message_chunk` is a delta wire. The mapper is therefore a stateful
 * factory: it remembers how much of each message's text it has already
 * relayed and emits only the new suffix. Create one mapper per prompt turn.
 *
 * `tool_end` covers BOTH a successful tool result and a failed one (a tool's
 * own `execute` throwing, or the SDK failing to resolve the call) — the old
 * raw-stream `tool-result`/`tool-error` split collapses into `isError`.
 * Dropping failures used to leave the matching `tool_call` stuck
 * "in_progress" forever on the ACP wire, so failed calls map to a `failed`
 * update carrying the error text.
 */

import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk"
import type { AgentControllerEvent } from "@mastra/core/agent-controller"

/** Map a workspace tool id to the ACP {@link ToolKind} that drives client
 *  icon/UI treatment. Unknown ids fall back to "other". */
export function toolKindFor(toolName: string): ToolKind {
  switch (toolName) {
    case "read_file":
    case "list_dir":
      return "read"
    case "write_file":
    case "edit_file":
      return "edit"
    case "run_command":
      return "execute"
    default:
      return "other"
  }
}

/** A short, human-readable title for a tool call, e.g. `run_command: ls -la`
 *  or `read_file: src/index.ts`. Falls back to the bare tool name. */
export function toolCallTitle(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const { command, path, file } = args as Record<string, unknown>
    const hint =
      (typeof command === "string" && command) ||
      (typeof path === "string" && path) ||
      (typeof file === "string" && file) ||
      ""
    if (hint) return `${toolName}: ${hint}`
  }
  return toolName
}

/** Render a failed tool result (an `Error`, a string, or an arbitrary
 *  provider error shape) as a single human-readable line. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Concatenate a message's plain-text parts (assistant prose; reasoning and
 *  tool-invocation parts are not ACP message text). */
function messageText(message: { content?: { parts?: unknown[] } }): string {
  const parts = message.content?.parts
  if (!Array.isArray(parts)) return ""
  let text = ""
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text
    }
  }
  return text
}

/**
 * Create a stateful event mapper for one prompt turn: translates each
 * controller event into an ACP `session/update` payload, or `null` when the
 * event has no ACP surface (or carries no new text). The ACP host wraps each
 * result with the `sessionId`.
 */
export function createEventMapper(): (
  event: AgentControllerEvent,
) => SessionUpdate | null {
  // message id → how many chars of its text we have already relayed.
  const relayed = new Map<string, number>()

  return (event) => {
    switch (event.type) {
      case "message_update": {
        if (event.message.role !== "assistant") return null
        const text = messageText(event.message)
        const seen = relayed.get(event.message.id) ?? 0
        if (text.length <= seen) return null
        relayed.set(event.message.id, text.length)
        return {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: text.slice(seen) },
        }
      }
      case "tool_start": {
        if (!event.toolCallId) return null
        const toolName = event.toolName || "tool"
        return {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: toolCallTitle(toolName, event.args),
          kind: toolKindFor(toolName),
          status: "in_progress",
          rawInput: event.args,
        }
      }
      case "tool_end": {
        if (!event.toolCallId) return null
        return {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          rawOutput: event.isError
            ? { error: errorMessage(event.result) }
            : event.result,
        }
      }
      default:
        return null
    }
  }
}
