/**
 * AIP-45 protocol arm: `protocol: "print"`.
 *
 * Drives a headless CLI as one fresh subprocess per turn — no
 * long-lived ACP connection. Simpler than the ACP arm and immune to
 * the stale-proxy race condition: the session object itself never dies
 * between turns; only the per-turn child does.
 *
 * ## Configuration
 *
 * The adapter's `print` manifest block declares the CLI's one-shot
 * surface (flags, output format, event taxonomy). When the block is
 * absent, Claude Code defaults are applied for backward compatibility.
 *
 * ## Session tracking
 *
 * The `sessionId` property starts empty (or pre-seeded from
 * `resumeSessionId`) and is updated after the first successful turn
 * from the wire event that carries the session / thread identifier
 * (Claude: `result.session_id`; Mastra: `result.threadId`).
 * Subsequent turns pass the appropriate resume flag so the CLI
 * rehydrates the conversation.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { toFileBasedMcpServers } from "../mcp-servers.js"
import type {
  AcpMcpServer,
  AgentCliPrintConfig,
  AgentCliRuntimeSession,
  StreamEvent,
} from "../types.js"

export interface PrintArmOptions {
  bin: string
  /** Base argv passed to the binary BEFORE print flags and prompt.
   *  Typically permission-mode and model overrides from `composeSpawn`. */
  baseArgs: string[]
  cwd: string
  env: Record<string, string>
  /** Pre-seed from `resumeSessionId` so the first turn reattaches. */
  resumeSessionId?: string
  /** Adapter-declared print surface config. Omit for Claude defaults. */
  printConfig?: AgentCliPrintConfig
  /**
   * MCP servers to mount into the agent's session. For the `mastracode`
   * print arm (`event_schema: "mastra-jsonl"`) these are written to
   * `<cwd>/.mastracode/mcp.json` before the first turn's spawn (the
   * mastracode CLI has no CLI flag / env var / config-dir override for
   * MCP config — this was exhaustively verified against its source) and
   * restored/removed on `close()`. Ignored for other print schemas
   * (e.g. Claude Code), which don't load MCP config from this path.
   */
  mcpServers?: AcpMcpServer[]
}

// ── Defaults (Claude Code backward-compatible) ──────────────────────

const DEFAULT_OUTPUT: string[] = ["--output-format", "stream-json"]
const DEFAULT_PRE_PROMPT: string[] = ["--no-interactive"]
const DEFAULT_RESUME = { flag: "--resume", kind: "value" as const }

export function createPrintSession(
  opts: PrintArmOptions,
): AgentCliRuntimeSession {
  const config = opts.printConfig
  const outputFormat = config?.output_format ?? DEFAULT_OUTPUT
  const prePrompt = config?.pre_prompt ?? DEFAULT_PRE_PROMPT
  const promptFlag = config?.prompt_flag
  const resumeCfg = config?.resume ?? DEFAULT_RESUME
  const eventSchema = config?.event_schema ?? "claude-stream-json"

  let sessionId = opts.resumeSessionId ?? ""
  let activeChild: ReturnType<typeof spawn> | null = null

  // ── MCP server injection (mastracode print arm only) ─────────────
  // The mastracode CLI has no CLI flag, env var, or config-dir override
  // for MCP config (exhaustively verified against its source). The only
  // way to mount host-chosen MCP servers into a print-arm subprocess is
  // to write them into `<cwd>/.mastracode/mcp.json`, which mastracode
  // loads at process startup as its highest-precedence project-scope
  // config. This is done once here (before the first turn's spawn) and
  // restored on close(). Only applies when the adapter is mastracode
  // (`event_schema: "mastra-jsonl"`) — other print adapters (Claude
  // Code) don't read this path.
  const mcpRestore = setupMcpConfigFile(opts, eventSchema)

  return {
    get sessionId(): string {
      return sessionId
    },

    async *send(message: unknown): AsyncIterable<StreamEvent> {
      const prompt = extractPromptText(message)

      // Build argv: baseArgs + output_format + pre_prompt +
      //             resume_flag(+value) + prompt_flag(+text) | positional
      const args: string[] = [
        ...opts.baseArgs,
        ...outputFormat,
        ...prePrompt,
      ]

      // Resume flag
      if (sessionId) {
        args.push(resumeCfg.flag)
        if (resumeCfg.kind === "value") args.push(sessionId)
      }

      // Prompt: flag or positional
      if (promptFlag) {
        args.push(promptFlag, prompt)
      } else {
        args.push(prompt)
      }

      const child = spawn(opts.bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      activeChild = child

      const stderrLines: string[] = []
      const STDERR_KEEP = 80
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line) continue
          stderrLines.push(line)
          if (stderrLines.length > STDERR_KEEP) stderrLines.shift()
        }
      })

      try {
        if (!child.stdout)
          throw new Error("print-arm: child has no stdout pipe")
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

        let capturedSessionId = ""
        const mastraState =
          eventSchema === "mastra-jsonl"
            ? createMastraMapperState()
            : undefined
        for await (const line of rl) {
          if (!line.trim()) continue
          let evt: Record<string, unknown>
          try {
            evt = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }

          // Capture the session/thread id from the wire event
          const csid = captureSessionId(evt, eventSchema)
          if (csid) capturedSessionId = csid

          const sid = capturedSessionId || sessionId || ""
          const mapped = mapEvent(evt, sid, stderrLines, eventSchema, mastraState)
          if (!mapped) continue

          yield mapped
        }

        const exitCode = await waitForExit(child)
        if (capturedSessionId) sessionId = capturedSessionId

        if (exitCode !== 0 && exitCode !== null) {
          const binLabel =
            eventSchema === "mastra-jsonl" ? "mastracode" : "claude"
          const errEvt: StreamEvent = {
            kind: "error",
            error: {
              message: `${binLabel} exited with code ${exitCode}`,
              ...(stderrLines.length
                ? { data: { stderr: stderrLines.join("\n") } }
                : {}),
            },
          }
          yield errEvt
        }
      } finally {
        activeChild = null
      }
    },

    async cancel(): Promise<void> {
      activeChild?.kill("SIGTERM")
    },

    async close(): Promise<void> {
      activeChild?.kill("SIGTERM")
      mcpRestore?.()
    },
  }
}

// ── MCP config file injection (mastracode print arm) ────────────────

/**
 * Before the first turn's spawn, shallow-merges our injected MCP servers
 * into `<cwd>/.mastracode/mcp.json` (the highest-precedence project-scope
 * config mastracode loads). Returns a restore function that reverts the
 * file to its pre-session state on `close()`, or `undefined` if no
 * injection was performed.
 *
 * Only activates when `eventSchema === "mastra-jsonl"` (mastracode) AND
 * `opts.mcpServers` is non-empty. Other print adapters (Claude Code)
 * don't read this path and are left untouched.
 *
 * Our injected servers win on key collision — this matches mastracode's
 * own "higher precedence overrides lower, by server name" merge
 * semantics, and the SDK's documented "merged with, and overriding,
 * file-based configs" behavior for the in-process arm, so both arms
 * behave consistently.
 *
 * KNOWN LIMITATION: two concurrent mastracode print sessions sharing
 * the SAME `cwd` will race on this read-merge-write (last writer wins
 * on the shared file). This is an upstream mastracode CLI limitation —
 * no config-dir isolation exists to route around it. This is a real but
 * narrow edge case (only matters for concurrent orchestrator children
 * spawned into the identical directory); no locking mechanism is built
 * here, by design.
 */
function setupMcpConfigFile(
  opts: PrintArmOptions,
  eventSchema: "claude-stream-json" | "mastra-jsonl",
): (() => void) | undefined {
  if (eventSchema !== "mastra-jsonl") return undefined
  if (!opts.mcpServers || opts.mcpServers.length === 0) return undefined

  const dir = join(opts.cwd, ".mastracode")
  const file = join(dir, "mcp.json")
  const injected = toFileBasedMcpServers(opts.mcpServers)
  if (!injected) return undefined

  // Snapshot the pre-session state so close() can restore it.
  const fileExisted = existsSync(file)
  let originalContent: string | undefined
  if (fileExisted) {
    try {
      originalContent = readFileSync(file, "utf8")
    } catch {
      originalContent = undefined
    }
  }
  const dirExisted = existsSync(dir)

  // Ensure `.mastracode/` exists, then read-merge-write.
  if (!dirExisted) {
    mkdirSync(dir, { recursive: true })
  }

  let existingServers: Record<string, unknown> = {}
  if (originalContent !== undefined) {
    try {
      const parsed = JSON.parse(originalContent) as Record<string, unknown>
      if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
        existingServers = parsed.mcpServers as Record<string, unknown>
      }
    } catch {
      // Corrupt or unparseable file — start fresh with just our servers.
      existingServers = {}
    }
  }

  // Shallow-merge: our injected servers override on key collision.
  const merged: Record<string, unknown> = { ...existingServers, ...injected }
  const output = JSON.stringify({ mcpServers: merged }, null, 2)
  writeFileSync(file, output, "utf8")

  // Return the restore function.
  return () => {
    try {
      if (!fileExisted) {
        // We created the file — remove it. Also remove the `.mastracode/`
        // dir only if we created that too AND it's now empty (don't
        // rm -rf someone's existing directory).
        rmSync(file, { force: true })
        if (!dirExisted) {
          try {
            // `rmdirSync` (not `rmSync`) — only removes an EMPTY
            // directory, throwing ENOTEMPTY otherwise. `rmSync` without
            // `recursive: true` throws on any directory regardless of
            // contents, which would always land in the catch below and
            // silently leave the directory behind even when empty.
            rmdirSync(dir)
          } catch {
            // Directory not empty (other files were added) — leave it.
          }
        }
      } else if (originalContent !== undefined) {
        // File existed before — restore its original content, but first
        // remove only our injected keys from the merged object so any
        // concurrent changes (if the file was modified externally) are
        // preserved minus our entries. If that produces an empty
        // mcpServers map, restore the original file verbatim.
        let current: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
            current = parsed.mcpServers as Record<string, unknown>
          }
        } catch {
          // Can't read current state — restore original verbatim.
          writeFileSync(file, originalContent, "utf8")
          return
        }
        for (const key of Object.keys(injected)) {
          delete current[key]
        }
        if (Object.keys(current).length === 0) {
          // All servers were ours — restore original file content.
          writeFileSync(file, originalContent, "utf8")
        } else {
          writeFileSync(file, JSON.stringify({ mcpServers: current }, null, 2), "utf8")
        }
      }
    } catch {
      // Best-effort — never throw from close().
    }
  }
}

// ── Prompt extraction ───────────────────────────────────────────────

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message
  if (message !== null && typeof message === "object") {
    const m = message as Record<string, unknown>
    if (typeof m.text === "string") return m.text
    if (Array.isArray(message)) {
      return (message as Array<Record<string, unknown>>)
        .filter(b => b.type === "text" && typeof b.text === "string")
        .map(b => b.text as string)
        .join("\n")
    }
  }
  return JSON.stringify(message)
}

// ── Session id capture per event schema ─────────────────────────────

function captureSessionId(
  evt: Record<string, unknown>,
  schema: "claude-stream-json" | "mastra-jsonl",
): string | null {
  switch (schema) {
    case "claude-stream-json":
      if (
        evt.type === "result" &&
        typeof evt.session_id === "string" &&
        evt.session_id
      )
        return evt.session_id
      return null
    case "mastra-jsonl":
      // Mastra Code writes exactly one authoritative final line per run
      // regardless of success/failure path: { type: "result", threadId,
      // text, finishReason, exitCode, ... }. Reading it here (rather than
      // the incidental om_status event, which only fires when
      // Observational Memory is enabled) guarantees the thread id is
      // captured on every turn.
      if (
        evt.type === "result" &&
        typeof evt.threadId === "string" &&
        evt.threadId
      )
        return evt.threadId
      return null
  }
}

// ── Event mapping ───────────────────────────────────────────────────

function mapEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
  schema: "claude-stream-json" | "mastra-jsonl",
  mastraState?: MastraMapperState,
): StreamEvent | null {
  switch (schema) {
    case "claude-stream-json":
      return mapClaudeEvent(evt, sessionId, stderrLines)
    case "mastra-jsonl": {
      if (!mastraState) {
        // Should never happen — mastra-jsonl schema always creates state
        return mapClaudeEvent(evt, sessionId, stderrLines)
      }
      return mapMastraEvent(evt, sessionId, stderrLines, mastraState)
    }
    default:
      return mapClaudeEvent(evt, sessionId, stderrLines)
  }
}

// ── Claude Code stream-json mapper ──────────────────────────────────

function mapClaudeEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
): StreamEvent | null {
  switch (evt.type) {
    case "text":
      return typeof evt.text === "string"
        ? { kind: "text-delta", sessionId, text: evt.text }
        : null

    case "thinking":
      return typeof evt.thinking === "string"
        ? { kind: "thought", sessionId, text: evt.thinking }
        : null

    case "tool_use":
      return {
        kind: "tool-call",
        sessionId,
        toolCallId: typeof evt.id === "string" ? evt.id : "",
        toolName: typeof evt.name === "string" ? evt.name : "?",
        arguments: evt.input ?? {},
      }

    case "tool_result":
      return {
        kind: "tool-result",
        sessionId,
        toolCallId:
          typeof evt.tool_use_id === "string" ? evt.tool_use_id : "",
        result: evt.content ?? null,
        isError: evt.is_error === true,
      }

    case "result":
      if (
        evt.subtype === "error_during_execution" ||
        evt.is_error === true
      ) {
        return {
          kind: "error",
          sessionId,
          error: {
            message:
              typeof evt.error === "string"
                ? evt.error
                : "Unknown error",
            ...(stderrLines.length
              ? { data: { stderr: stderrLines.join("\n") } }
              : {}),
          },
        }
      }
      if (evt.subtype === "success") {
        return { kind: "turn-end", sessionId, reason: "completed" }
      }
      return null

    case "system":
    case "assistant":
      return null

    default:
      return null
  }
}

// ── Mastra Code JSONL mapper ────────────────────────────────────────

/**
 * Mutable per-stream state for the Mastra Code event mapper.
 * Mastra Code sends the FULL accumulated text on each `message_update`,
 * so we track the previous length to emit only the new portion.
 *
 * Exported so other Mastra Code protocol arms (e.g. the in-process
 * `proprietary` arm in `@agentproto/adapter-mastracode-inprocess`) can
 * reuse the same event mapper instead of reimplementing it — the wire
 * shape here is `AgentControllerEvent` regardless of whether it arrived
 * over a JSONL subprocess pipe or as a live in-process object.
 */
export interface MastraMapperState {
  lastTextLength: number
}

export function createMastraMapperState(): MastraMapperState {
  return { lastTextLength: 0 }
}

/**
 * Extract text from Mastra Code content blocks.
 * Blocks are `{ type: "text", text: "..." }` arrays on `message.content`.
 */
function extractTextFromBlocks(
  content: unknown,
): string {
  if (!Array.isArray(content)) return ""
  return (content as Array<Record<string, unknown>>)
    .filter(c => c.type === "text" && typeof c.text === "string")
    .map(c => c.text as string)
    .join("")
}

/**
 * Maps a single Mastra Code `AgentControllerEvent` (already a plain
 * object — JSON-parsed from a subprocess line, or handed over directly
 * by an in-process arm) to this repo's {@link StreamEvent} taxonomy.
 * `stderrLines` enriches `error` events for arms that have a real
 * subprocess to report on; pass `[]` when there is none (e.g. the
 * in-process arm).
 */
export function mapMastraEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
  state: MastraMapperState,
): StreamEvent | null {
  switch (evt.type) {
    // ── Text streaming ──────────────────────────────────────────
    case "message_update": {
      const content = (evt.message as Record<string, unknown>)?.content
      const fullText = extractTextFromBlocks(content)
      if (fullText.length > state.lastTextLength) {
        const delta = fullText.slice(state.lastTextLength)
        state.lastTextLength = fullText.length
        return delta ? { kind: "text-delta", sessionId, text: delta } : null
      }
      return null
    }

    case "message_end": {
      const msg = evt.message as Record<string, unknown> | undefined
      if (msg?.role !== "assistant") return null
      const fullText = extractTextFromBlocks(msg?.content)
      // Emit any remaining text not covered by message_update deltas
      if (fullText.length > state.lastTextLength) {
        const delta = fullText.slice(state.lastTextLength)
        state.lastTextLength = fullText.length
        return delta ? { kind: "text-delta", sessionId, text: delta } : null
      }
      return null
    }

    // ── Tool calls ──────────────────────────────────────────────
    case "tool_start":
      return {
        kind: "tool-call",
        sessionId,
        toolCallId:
          typeof evt.toolCallId === "string" ? evt.toolCallId : "",
        toolName:
          typeof evt.toolName === "string" ? evt.toolName : "?",
        // Mastra's controller event carries the tool call payload under
        // `args`, not `input` (that's the Claude Code stream-json field
        // name used by the sibling mapClaudeEvent tool_use case below).
        arguments: evt.args ?? {},
      }

    case "tool_end":
      return {
        kind: "tool-result",
        sessionId,
        toolCallId:
          typeof evt.toolCallId === "string" ? evt.toolCallId : "",
        result: evt.result ?? null,
        isError: evt.isError === true,
      }

    // ── Turn end ────────────────────────────────────────────────
    case "agent_end": {
      const rawReason =
        typeof evt.reason === "string"
          ? evt.reason
          : "complete"
      const reason = mapMastraFinishReason(rawReason)
      return { kind: "turn-end", sessionId, reason }
    }

    // ── Final result line ────────────────────────────────────────
    // Always written last, once, whether or not `agent_end` fired —
    // pre-flight failures (bad model, unresolvable thread, missing API
    // key) call straight into this without ever streaming an
    // `agent_end` or `error` event. `turn-end` already came from
    // `agent_end` on the success path, so this only needs to surface
    // an error for the pre-flight-failure path.
    case "result": {
      const err = evt.error as Record<string, unknown> | undefined
      if (!err) return null
      return {
        kind: "error",
        sessionId,
        error: {
          message:
            typeof err.message === "string" ? err.message : "Unknown error",
          ...(stderrLines.length
            ? { data: { stderr: stderrLines.join("\n") } }
            : {}),
        },
      }
    }

    // ── Errors ─────────────────────────────────────────────────
    case "error": {
      const err = evt.error as Record<string, unknown> | undefined
      return {
        kind: "error",
        sessionId,
        error: {
          message:
            typeof err?.message === "string"
              ? err.message
              : "Unknown error",
          ...(stderrLines.length
            ? { data: { stderr: stderrLines.join("\n") } }
            : {}),
        },
      }
    }

    // ── Shell output (tool-like) ────────────────────────────────
    case "shell_output":
      return typeof evt.output === "string"
        ? {
            kind: "tool-result",
            sessionId,
            toolCallId: "",
            result: evt.output,
            isError: false,
          }
        : null

    // ── Skipped events ─────────────────────────────────────────
    case "agent_start":
    case "subagent_start":
    case "subagent_end":
    case "tool_approval_required":
    case "tool_suspended":
      return null

    default:
      return null
  }
}

// ── Process helpers ─────────────────────────────────────────────────

/**
 * Normalize Mastra Code `agent_end.finishReason` to StreamEvent turn-end reason.
 * Mastra uses: "complete", "aborted", "error", "suspended"
 * StreamEvent expects: "completed", "cancelled", "error", "max_turns"
 */
function mapMastraFinishReason(
  raw: string,
): "completed" | "cancelled" | "max_turns" | "error" {
  switch (raw) {
    case "complete":
      return "completed"
    case "aborted":
    case "suspended":
      return "cancelled"
    case "error":
      return "error"
    default:
      return "completed"
  }
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  return new Promise(resolve => {
    child.once("exit", code => resolve(code))
    child.once("error", () => resolve(null))
  })
}
