/**
 * `agentproto run <slug> [--cwd <dir>] [--prompt <text>] [--resume <id>]`
 *
 * Boots the named adapter, dispatches a single user turn, streams events
 * to stdout, then exits. Designed for two use-cases:
 *   - one-shot scripting (pipe a prompt in, get stream back)
 *   - quick smoke-test from a fresh checkout ("does claude even spawn?")
 *
 * Long-lived multiplexing belongs to `agentproto serve`, not here.
 */

import { resolve as resolvePath } from "node:path"
import { parseArgs } from "node:util"
import {
  createAgentCliRuntime,
  type AgentCliRuntimeSession,
  type StreamEvent,
} from "@agentproto/driver-agent-cli"
import { formatToolCall, formatToolResult } from "@agentproto/runtime"
import { resolveAdapter } from "../registry/resolve.js"
import { readStdinIfPiped } from "../util/stdin.js"

export async function runRun(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      prompt: { type: "string", short: "p" },
      resume: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto run: missing adapter slug. Try: agentproto run claude-code\n"
    )
    return 2
  }

  const cwd = values.cwd ? resolvePath(values.cwd) : process.cwd()
  const promptArg = values.prompt ?? (await readStdinIfPiped())
  if (!promptArg) {
    process.stderr.write(
      "agentproto run: no prompt provided. Pass --prompt or pipe one over stdin.\n"
    )
    return 2
  }

  const adapter = await resolveAdapter(slug)
  const runtime = createAgentCliRuntime(adapter.handle)

  const controller = new AbortController()
  const onSignal = (sig: NodeJS.Signals) => {
    process.stderr.write(`\nagentproto: received ${sig}, cancelling…\n`)
    controller.abort()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  let session: AgentCliRuntimeSession | null = null
  try {
    session = await runtime.start({
      cwd,
      signal: controller.signal,
      resumeSessionId: values.resume,
    })

    const printer = values.json ? printJson : printPretty
    let exit = 0
    for await (const ev of session.send(promptArg)) {
      printer(ev)
      if (ev.kind === "turn-end" && ev.reason !== "completed") exit = 1
      if (ev.kind === "error") exit = 1
    }
    return exit
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    if (session) await session.close().catch(() => {})
  }
}

function printJson(ev: StreamEvent): void {
  process.stdout.write(`${JSON.stringify(ev)}\n`)
}

function printPretty(ev: StreamEvent): void {
  switch (ev.kind) {
    case "text-delta":
      process.stdout.write(ev.text)
      break
    case "thought":
      process.stderr.write(`\x1b[2m[thought] ${ev.text}\x1b[0m\n`)
      break
    case "tool-call":
      process.stderr.write(
        `\x1b[36m[tool] ${formatToolCall(ev.toolName, ev.arguments)}\x1b[0m\n`
      )
      break
    case "tool-result": {
      const summary = formatToolResult(undefined, ev.result, ev.isError ?? false)
      if (summary) {
        process.stderr.write(
          ev.isError
            ? `\x1b[31m[tool-error] ${summary}\x1b[0m\n`
            : `\x1b[2m[tool-result] ${summary}\x1b[0m\n`
        )
      } else if (ev.isError) {
        process.stderr.write(`\x1b[31m[tool-error]\x1b[0m\n`)
      }
      break
    }
    case "agent-prompt":
      process.stderr.write(`\x1b[33m[agent-prompt: needs input]\x1b[0m\n`)
      break
    case "turn-end":
      process.stdout.write(`\n\x1b[2m[turn-end: ${ev.reason}]\x1b[0m\n`)
      break
    case "error": {
      const code =
        typeof ev.error.code === "number" ? ` (code ${ev.error.code})` : ""
      process.stderr.write(
        `\x1b[31m[error]${code} ${ev.error.message}\x1b[0m\n`,
      )
      // Attached child stderr (added by define-agent-cli) — usually
      // the most useful line ("not authenticated", "model gated",
      // missing binary path). Print after the headline so the
      // headline still scans first.
      const data = ev.error.data
      if (data && typeof data === "object") {
        const stderr = (data as { stderr?: unknown }).stderr
        if (typeof stderr === "string" && stderr.trim()) {
          process.stderr.write(`\x1b[2m── child stderr ──\n${stderr}\x1b[0m\n`)
        }
        // Surface any non-stderr fields as JSON so callers don't
        // have to switch to --json to see what payload was rejected.
        const rest = { ...(data as Record<string, unknown>) }
        delete rest.stderr
        if (Object.keys(rest).length > 0) {
          process.stderr.write(
            `\x1b[2m── error.data ──\n${JSON.stringify(rest, null, 2)}\x1b[0m\n`,
          )
        }
      }
      break
    }
  }
}
