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
import { createInterface } from "node:readline"
import type {
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
    },
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
 */
interface MastraMapperState {
  lastTextLength: number
}

function createMastraMapperState(): MastraMapperState {
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

function mapMastraEvent(
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
        arguments: evt.input ?? {},
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
