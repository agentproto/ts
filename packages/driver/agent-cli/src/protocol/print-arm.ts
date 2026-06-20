/**
 * AIP-45 protocol arm: `protocol: "print"`.
 *
 * Drives `claude -p --output-format stream-json [--resume <id>]` — one
 * fresh subprocess per turn, no long-lived ACP connection. Simpler than
 * the ACP arm and immune to the stale-proxy race condition: the session
 * object itself never dies between turns; only the per-turn child does.
 *
 * The `sessionId` property starts empty (or pre-seeded with a
 * `resumeSessionId`) and is updated after the first successful turn from
 * the `result` event's `session_id` field.  Subsequent turns pass
 * `--resume <sessionId>` so Claude Code rehydrates the conversation from
 * its JSONL store.
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { AgentCliRuntimeSession, StreamEvent } from "../types.js"

export interface PrintArmOptions {
  bin: string
  /** Base argv passed to the binary BEFORE print flags and prompt.
   *  Typically permission-mode and model overrides from `composeSpawn`. */
  baseArgs: string[]
  cwd: string
  env: Record<string, string>
  /** Pre-seed from `resumeSessionId` so the first turn reattaches. */
  resumeSessionId?: string
}

export function createPrintSession(opts: PrintArmOptions): AgentCliRuntimeSession {
  let sessionId = opts.resumeSessionId ?? ""
  let activeChild: ReturnType<typeof spawn> | null = null

  return {
    get sessionId(): string {
      return sessionId
    },

    async *send(message: unknown): AsyncIterable<StreamEvent> {
      const prompt = extractPromptText(message)

      const args: string[] = [
        ...opts.baseArgs,
        "--print",
        "--output-format",
        "stream-json",
        "--no-interactive",
        ...(sessionId ? ["--resume", sessionId] : []),
        prompt,
      ]

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
        if (!child.stdout) throw new Error("print-arm: child has no stdout pipe")
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

        let capturedSessionId = ""
        for await (const line of rl) {
          if (!line.trim()) continue
          let evt: Record<string, unknown>
          try {
            evt = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }

          if (
            evt.type === "result" &&
            typeof evt.session_id === "string" &&
            evt.session_id
          ) {
            capturedSessionId = evt.session_id
          }

          const sid = capturedSessionId || sessionId || ""
          const mapped = mapEvent(evt, sid, stderrLines)
          if (!mapped) continue

          yield mapped
        }

        const exitCode = await waitForExit(child)
        if (capturedSessionId) sessionId = capturedSessionId

        if (exitCode !== 0 && exitCode !== null) {
          const errEvt: StreamEvent = {
            kind: "error",
            error: {
              message: `claude exited with code ${exitCode}`,
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

function mapEvent(
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
              typeof evt.error === "string" ? evt.error : "Unknown error",
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
      // skip: init metadata and full message recap (streaming text-delta covers it)
      return null

    default:
      return null
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise(resolve => {
    child.once("exit", code => resolve(code))
    child.once("error", () => resolve(null))
  })
}
