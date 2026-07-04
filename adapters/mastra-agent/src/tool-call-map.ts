/**
 * Pure mapping from Mastra `fullStream` chunks to AIP-44 ACP `session/update`
 * payloads. Kept dependency-light (no SDK import beyond types) and side-effect
 * free so it is straightforward to unit-test; the ACP host (acp-host.ts) owns
 * the wire/IO and just forwards whatever this returns.
 *
 * Mastra emits a typed chunk union on `agent.stream(...).fullStream`. We care
 * about three kinds:
 *   - `text-delta`  → ACP `agent_message_chunk` (assistant prose)
 *   - `tool-call`   → ACP `tool_call`        (a tool started, status in_progress)
 *   - `tool-result` → ACP `tool_call_update` (that tool finished/failed)
 * Everything else (reasoning, step boundaries, finish, …) is not surfaced.
 */

import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk"

/** The narrow slice of a Mastra fullStream chunk we read. Typed structurally
 *  so we don't couple to a specific @mastra/core version.
 *  Mastra 1.45 wraps all chunk data in a `payload` field. */
export type MastraStreamChunk =
  | { type: "text-delta"; payload?: { text?: string } }
  | { type: "tool-call"; payload?: { toolCallId?: string; toolName?: string; args?: unknown } }
  | { type: "tool-result"; payload?: { toolCallId?: string; result?: unknown; isError?: boolean } }

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

/**
 * Translate one Mastra chunk into an ACP `session/update` payload, or `null`
 * when the chunk has no ACP surface (or is missing the ids we need). The ACP
 * host wraps the result with the `sessionId`.
 */
export function chunkToSessionUpdate(
  chunk: MastraStreamChunk,
): SessionUpdate | null {
  switch (chunk.type) {
    case "text-delta": {
      const text = chunk.payload?.text
      if (!text) return null
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      }
    }
    case "tool-call": {
      const toolCallId = chunk.payload?.toolCallId
      if (!toolCallId) return null
      const toolName = chunk.payload?.toolName ?? "tool"
      const args = chunk.payload?.args
      return {
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolCallTitle(toolName, args),
        kind: toolKindFor(toolName),
        status: "in_progress",
        rawInput: args,
      }
    }
    case "tool-result": {
      const toolCallId = chunk.payload?.toolCallId
      if (!toolCallId) return null
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: chunk.payload?.isError ? "failed" : "completed",
        rawOutput: chunk.payload?.result,
      }
    }
    default:
      return null
  }
}
