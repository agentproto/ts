/**
 * `agentproto chat <adapter>` — an interactive, multi-turn REPL on top of a
 * daemon-hosted agent session.
 *
 * Where `run` is one-shot (pipe a prompt, get a stream, exit) and
 * `sessions --attach` is read-only output, `chat` is the human loop: type a
 * line → watch the agent's reply stream back (text, `[tool]` calls, thoughts,
 * `turn-end`) → type again. It's a thin client — all the rendering already
 * happens in the daemon (see runtime `projectEvent`), which emits ready-made
 * lines over `GET /sessions/:id/stream`; we just interleave them with a
 * readline prompt and POST each turn to `/sessions/:id/prompt`.
 *
 *   agentproto chat mastra-agent --model anthropic/claude-sonnet-4-6
 *   agentproto chat claude-code --cwd .            # default model
 *
 * The session is spawned fresh and killed on exit (`/exit`, `/quit`, or
 * Ctrl-C). Pass `--keep` to leave it alive (visible in `agentproto sessions`)
 * for a later `sessions --attach`.
 */
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { createInterface, type Interface } from "node:readline"
import http from "node:http"
import https from "node:https"
import type { SessionDescriptor } from "@agentproto/runtime"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  type DaemonEndpoint,
} from "./_daemon-helpers.js"

const USAGE = `agentproto chat — interactive REPL on a daemon agent session

Usage:
  agentproto chat <adapter> [--model <id>] [--cwd <dir>] [--workspace <slug>]
                            [--label <text>] [--keep] [--no-color]

Examples:
  agentproto chat mastra-agent --model anthropic/claude-sonnet-4-6
  agentproto chat claude-code --cwd .

In-session commands:
  /exit, /quit   end the chat (and stop the session unless --keep)
  Ctrl-C         same as /exit

Needs a running daemon (\`agentproto serve\`). Each typed line is one turn;
the agent's reply — text, [tool] calls, [thought]s — streams back live.`

/** Strip ANSI SGR sequences for --no-color and for turn-end detection. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

export interface ChatLineClass {
  /** The line with ANSI stripped (for matching / no-color rendering). */
  plain: string
  /** This line marks the end of the agent's turn → re-prompt the user. */
  turnBoundary: boolean
  /** Don't echo this line (the noisy `── turn-end (…) ──` rule itself). */
  suppress: boolean
}

/**
 * Classify one daemon SSE output line. Pure — the readline loop uses it to
 * decide what to print and when to hand control back to the user.
 *
 * Boundaries: the daemon's `── turn-end (…) ──` marker (suppressed, it's just
 * a rule), or the `[awaiting input]` nudge (shown, it's actionable).
 */
export function classifyChatLine(raw: string): ChatLineClass {
  const plain = raw.replace(ANSI, "")
  if (/── turn-end \(/.test(plain)) {
    return { plain, turnBoundary: true, suppress: true }
  }
  if (/\[awaiting input\]/.test(plain)) {
    return { plain, turnBoundary: true, suppress: false }
  }
  return { plain, turnBoundary: false, suppress: false }
}

export async function runChat(args: readonly string[]): Promise<number> {
  let values: {
    model?: string
    cwd?: string
    workspace?: string
    label?: string
    keep?: boolean
    "no-color"?: boolean
    help?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: "string" },
        cwd: { type: "string" },
        workspace: { type: "string" },
        label: { type: "string" },
        keep: { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`agentproto chat: ${(err as Error).message}\n\n${USAGE}\n`)
    return 2
  }

  if (values.help) {
    process.stdout.write(USAGE + "\n")
    return 0
  }

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto chat: missing adapter slug.\n" +
        "  Try: agentproto chat mastra-agent\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto chat: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto chat")
    return 2
  }
  const endpoint = report.found
  const colour = !values["no-color"] && process.stdout.isTTY === true

  // Spawn the session idle — we drive it turn by turn, so no initial prompt.
  const body: Record<string, string> = { adapter: slug }
  if (values.cwd) body.cwd = resolve(values.cwd)
  if (values.workspace) body.workspaceSlug = values.workspace
  if (values.model) body.model = values.model
  body.label = values.label ?? "chat"

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/agent`,
      body,
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        `agentproto chat: ${msg}\n` +
          "  The daemon requires a bearer token — set AGENTPROTO_DAEMON_TOKEN " +
          "or run from a workspace whose .agentproto/runtime.json carries it.\n",
      )
    } else {
      process.stderr.write(`agentproto chat: ${msg}\n`)
    }
    return 1
  }

  return driveChat({ endpoint, desc, slug, colour, keep: values.keep === true })
}

interface DriveOpts {
  endpoint: DaemonEndpoint
  desc: SessionDescriptor
  slug: string
  colour: boolean
  keep: boolean
}

/**
 * Run the readline loop against a live session: open the SSE output stream,
 * print each line, and re-show the prompt whenever a turn ends. Resolves with
 * the process exit code once the user quits or the session dies.
 */
function driveChat(opts: DriveOpts): Promise<number> {
  const { endpoint, desc, slug, colour } = opts
  const c = colour
    ? { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", reset: "\x1b[0m" }
    : { dim: "", bold: "", cyan: "", reset: "" }
  const youPrompt = `${c.bold}${c.cyan}you ›${c.reset} `

  return new Promise<number>(done => {
    const rl: Interface = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: youPrompt,
    })

    let closed = false
    let turnInFlight = false

    const banner =
      `${c.dim}─ chat · ${slug}${desc.model ? ` · ${desc.model}` : ""} · ` +
      `session ${desc.id} · /exit or Ctrl-C to quit ─${c.reset}\n`
    process.stdout.write(banner)

    // ── SSE output stream ──────────────────────────────────────────────────
    const url = new URL(`${endpoint.url}/sessions/${desc.id}/stream`)
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`

    const onTurnBoundary = (): void => {
      if (!turnInFlight) return
      turnInFlight = false
      // The agent finished — hand the line back to the user.
      rl.resume()
      rl.prompt()
    }

    const req = lib.get(url, { headers }, res => {
      if (res.statusCode !== 200) {
        process.stderr.write(`\nagentproto chat: stream HTTP ${res.statusCode}\n`)
        cleanup(1)
        return
      }
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", chunk => {
        buf += chunk
        let idx = buf.indexOf("\n\n")
        while (idx !== -1) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const evLine of event.split("\n")) {
            if (!evLine.startsWith("data:")) continue
            try {
              const json = JSON.parse(evLine.slice(5).trim()) as {
                line?: string
                stream?: "stdout" | "stderr"
              }
              if (typeof json.line !== "string") continue
              renderLine(json.line)
            } catch {
              // Ignore heartbeats / ill-formed frames.
            }
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => {
        if (!closed) {
          process.stdout.write(`\n${c.dim}─ session ended ─${c.reset}\n`)
          cleanup(0)
        }
      })
    })
    req.on("error", err => {
      if (!closed) {
        process.stderr.write(`\nagentproto chat: stream error: ${err.message}\n`)
        cleanup(1)
      }
    })

    const renderLine = (raw: string): void => {
      const { plain, turnBoundary, suppress } = classifyChatLine(raw)
      if (!suppress) process.stdout.write((colour ? raw : plain) + "\n")
      else process.stdout.write("\n")
      if (turnBoundary) onTurnBoundary()
    }

    // ── readline loop ──────────────────────────────────────────────────────
    rl.on("line", line => {
      const text = line.trim()
      if (text === "/exit" || text === "/quit") {
        cleanup(0)
        return
      }
      if (text === "") {
        if (!turnInFlight) rl.prompt()
        return
      }
      if (turnInFlight) {
        // A turn is still streaming — ignore (Mastra would cancel + restart).
        return
      }
      turnInFlight = true
      rl.pause()
      httpPostJson(`${endpoint.url}/sessions/${desc.id}/prompt`, { prompt: text }, endpoint.token)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`\nagentproto chat: prompt failed: ${msg}\n`)
          turnInFlight = false
          rl.resume()
          rl.prompt()
        })
    })

    rl.on("SIGINT", () => cleanup(0))

    // First turn — wait for the spawn banner to land, then prompt.
    setTimeout(() => {
      if (!closed && !turnInFlight) rl.prompt()
    }, 150)

    const cleanup = (code: number): void => {
      if (closed) return
      closed = true
      req.destroy()
      rl.close()
      const finish = (): void => done(code)
      if (opts.keep) {
        process.stdout.write(
          `${c.dim}─ session ${desc.id} left running (agentproto sessions) ─${c.reset}\n`,
        )
        finish()
        return
      }
      // Best-effort stop; don't block exit on it.
      httpPostJson(
        `${endpoint.url}/sessions/${encodeURIComponent(desc.id)}/kill`,
        {},
        endpoint.token,
      )
        .then(finish, finish)
    }
  })
}
