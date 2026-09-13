/**
 * `conversation_export` — cross-adapter conversation export.
 *
 * Converts a daemon session's transcript (events.jsonl — universal), once
 * normalised into the shared `ExportedSession` model, into a TARGET adapter's
 * native conversation-store format so the session can be resumed with that
 * adapter's CLI.
 *
 * ```
 * daemon events.jsonl → ExportedSession → target adapter's native store
 *                                          ├── claude-code JSONL
 *                                          └── (future: hermes sqlite, …)
 * ```
 *
 * The read side lives in `transcript-export.ts`; this module is the WRITE
 * side. It is deliberately read-only with respect to the daemon's own
 * events.jsonl — this produces a COPY, never a move, and never auto-resumes.
 * The caller gets back a `resumeCommand` it can hand to a human or run itself.
 */

import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import type { ExportedSession, ExportedMessage } from "./transcript-export.js"
import { claudeProjectSlug } from "./conversation-store.js"

/** Target adapter native stores we know how to WRITE to. Extensible — a
 *  `hermes`/`mastracode` arm slots in here later. */
export type ConversationExportTarget = "claude-code"

export interface ConversationExportResult {
  /** The adapter-native conversation id. For claude-code this is the jsonl
   *  file's uuid — the value passed to `claude --resume <uuid>`. */
  conversationId: string
  /** Absolute path of the written native-store file. */
  path: string
  /** Target adapter slug. */
  adapter: ConversationExportTarget
  /** Ready-to-run resume command, e.g. `claude --resume <uuid>`. */
  resumeCommand: string
  /** Number of ExportedMessages written (informational). */
  messageCount: number
}

export interface WriteToNativeStoreOptions {
  /** cwd that scopes the target store's directory. For claude-code this
   *  becomes the project slug under `~/.claude/projects/` (via
   *  `claudeProjectSlug`). Defaults to `process.cwd()`. */
  cwd?: string
}

// ── claude-code writer ────────────────────────────────────────────────
//
// Claude Code's native store: `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`,
// one line per JSON event. The line schema is reverse-engineered from
// `exportClaudeCodeSession` in transcript-export.ts (which only emits lines
// whose top-level `type` is `"user"` or `"assistant"`):
//   - first line  `{ type: "queue-operation", sessionId: "<uuid>" }`
//   - user turn   `{ type: "user", message: { role: "user", content: "…" } }`
//   - assistant   `{ type: "assistant", message: { role: "assistant",
//     content: [ {type:"thinking"}, {type:"text"}, {type:"tool_use"},
//                 {type:"tool_result"}, … ] } }`
//
// Tool RESULTS are not standalone lines — claude stores them as
// `tool_result` blocks attached to the ASSISTANT line they follow (and the
// reader in transcript-export.ts only emits role=user/assistant entries, so a
// standalone result line would be silently dropped). We therefore attach each
// `role:"tool"` ExportedMessage onto the most recently written assistant line.

interface ClaudeAssistantLine {
  type: "assistant"
  message: { role: "assistant"; content: unknown[] }
}

/** Build the content-block array for one assistant ExportedMessage. */
function buildAssistantBlocks(msg: ExportedMessage): unknown[] {
  const blocks: unknown[] = []
  if (msg.reasoning?.trim()) blocks.push({ type: "thinking", thinking: msg.reasoning })
  if (msg.text?.trim()) blocks.push({ type: "text", text: msg.text })
  for (const tc of msg.toolCalls ?? []) {
    let input: unknown
    try {
      input = JSON.parse(tc.args)
    } catch {
      input = tc.args
    }
    blocks.push({ type: "tool_use", name: tc.name, input })
  }
  return blocks
}

/**
 * Append one ExportedMessage as claude-code JSONL line(s). Returns the last
 * assistant line written (so a following `role:"tool"` message can attach its
 * `tool_result` block to it). `system` messages have no claude role of their
 * own — they are surfaced as a `[system]`-prefixed user line so the content
 * is never silently dropped (the reader would skip any other line type).
 */
function appendMessage(
  lines: unknown[],
  msg: ExportedMessage,
  lastAssistant: ClaudeAssistantLine | undefined,
): ClaudeAssistantLine | undefined {
  switch (msg.role) {
    case "user":
      lines.push({ type: "user", message: { role: "user", content: msg.text ?? "" } })
      return undefined

    case "assistant": {
      const assistant: ClaudeAssistantLine = {
        type: "assistant",
        message: { role: "assistant", content: buildAssistantBlocks(msg) },
      }
      lines.push(assistant)
      return assistant
    }

    case "tool": {
      const resultBlock = { type: "tool_result", content: msg.text ?? "" }
      if (lastAssistant) {
        lastAssistant.message.content.push(resultBlock)
        return lastAssistant
      }
      // No preceding assistant (defensive) — fabricate one carrying the result.
      const assistant: ClaudeAssistantLine = {
        type: "assistant",
        message: { role: "assistant", content: [resultBlock] },
      }
      lines.push(assistant)
      return assistant
    }

    case "system":
      lines.push({ type: "user", message: { role: "user", content: `[system] ${msg.text ?? ""}` } })
      return undefined
  }
}

async function writeClaudeCode(
  session: ExportedSession,
  cwd: string,
): Promise<ConversationExportResult> {
  const conversationId = randomUUID()
  const dir = join(homedir(), ".claude", "projects", claudeProjectSlug(cwd))
  const path = join(dir, `${conversationId}.jsonl`)

  const lines: unknown[] = [
    // Session metadata — the value claude echoes back in its on-exit resume
    // hint. Ignored by the transcript reader (IGNORED_CLAUDE_TYPES).
    { type: "queue-operation", sessionId: conversationId },
  ]
  let lastAssistant: ClaudeAssistantLine | undefined
  for (const msg of session.messages) {
    lastAssistant = appendMessage(lines, msg, lastAssistant)
  }

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf8")

  return {
    conversationId,
    path,
    adapter: "claude-code",
    resumeCommand: `claude --resume ${conversationId}`,
    messageCount: session.messages.length,
  }
}

// ── dispatch ─────────────────────────────────────────────────────────

/**
 * Write an `ExportedSession` into a target adapter's native store. Returns the
 * conversation id, the written file path, and a ready-to-run resume command.
 * The daemon's own events.jsonl is never touched — this is a COPY.
 */
export async function writeToNativeStore(
  session: ExportedSession,
  target: ConversationExportTarget,
  opts: WriteToNativeStoreOptions = {},
): Promise<ConversationExportResult> {
  const cwd = opts.cwd ?? process.cwd()
  switch (target) {
    case "claude-code":
      return writeClaudeCode(session, cwd)
    default: {
      const never: never = target
      void never
      throw new Error(`no writer for target adapter "${String(target)}"`)
    }
  }
}

// ── MCP tool ─────────────────────────────────────────────────────────

export interface ConversationExportInput {
  /** agentproto session id (sess_xxx) or session name. */
  sessionId: string
  /** Target adapter format whose native store to write. */
  target: ConversationExportTarget
  /** Override cwd scoping the native store (defaults to the session's cwd). */
  cwd?: string
}

export interface ConversationExportOps {
  registry: SessionsRegistry
  /** Overridable for tests — defaults to `exportDaemonEventsSession`. */
  exportFn?: (sessionId: string, desc?: SessionDescriptor) => Promise<ExportedSession>
}

/** Core logic shared by the MCP tool (and any future HTTP route / CLI):
 *  resolve a session → export its daemon-events transcript → write it to the
 *  target's native store → return the resume handle. Throws on failure (the
 *  MCP wrapper surfaces the message as an error). */
export async function exportConversation(
  registry: SessionsRegistry,
  input: ConversationExportInput,
  exportFn?: ConversationExportOps["exportFn"],
): Promise<ConversationExportResult> {
  const desc = registry.findByIdOrName(input.sessionId)
  if (!desc) {
    throw new Error(`conversation_export: session "${input.sessionId}" not found`)
  }

  const exporter = exportFn ?? (async (sid, d) => {
    const { exportDaemonEventsSession } = await import("./transcript-export.js")
    return exportDaemonEventsSession(sid, d)
  })
  const session = await exporter(desc.id, desc)

  const cwd = input.cwd ?? desc.cwd ?? process.cwd()
  return writeToNativeStore(session, input.target, { cwd })
}

/**
 * Register the `conversation_export` MCP tool — mirrors
 * `registerConversationReadTool`'s registry-access pattern, but WRITES a copy
 * of a daemon session's transcript into a target adapter's native store and
 * returns the resume handle.
 */
export function registerConversationExportTool(server: McpServer, ops: ConversationExportOps): void {
  server.tool(
    "conversation_export",
    "Convert a daemon session's transcript into a target adapter's native conversation-store " +
      "format so it can be resumed with that adapter's CLI. Reads the universal events.jsonl " +
      "capture (available for ANY agent-cli session), normalises it, and writes a COPY into " +
      "the target store — the daemon session is never modified, moved, or auto-resumed. Today " +
      "supports `claude-code` (~/.claude/projects/<cwd-slug>/<uuid>.jsonl), resumable with " +
      "`claude --resume <uuid>`. Returns the conversation id, the written path, and the " +
      "ready-to-run resume command. Works on stopped and running sessions alike.",
    {
      sessionId: z.string().describe("agentproto session id (sess_xxx) or session name."),
      target: z
        .enum(["claude-code"])
        .describe("Target adapter format whose native store to write. Extensible enum."),
      cwd: z
        .string()
        .optional()
        .describe(
          "Override cwd scoping the target store's directory (for claude-code this becomes " +
            "the project slug under ~/.claude/projects/). Defaults to the session's cwd.",
        ),
    },
    async input => {
      try {
        const result = await exportConversation(ops.registry, input, ops.exportFn)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true as const,
        }
      }
    },
  )
}