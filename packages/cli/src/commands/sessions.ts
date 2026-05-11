/**
 * `agentproto sessions [--watch] [--attach <id>] [--json]`
 *
 * Browse the daemon's live sessions (terminals, agent CLIs, custom
 * commands) without leaving the shell. Three usage modes:
 *
 *   agentproto sessions                  one-shot table dump
 *   agentproto sessions --watch          re-render every 2s, q to quit
 *   agentproto sessions --attach <id>    SSE-stream a session's output
 *
 * The TUI is intentionally minimal — raw stdin keypresses, no inquirer
 * / blessed dep. Terminal emulator quirks (xterm vs iTerm, key
 * sequences for arrow keys) are limited to a couple lines below.
 *
 * Endpoint discovery: reads `~/.agentproto/runtime.json` written by
 * the daemon at startup. Falls back to the env var
 * `AGENTPROTO_DAEMON_URL` when the file is missing or stale.
 */
import { parseArgs } from "node:util"
import { promises as fs } from "node:fs"
import { resolve } from "node:path"
import http from "node:http"
import https from "node:https"
import {
  loadWorkspacesConfig,
  getActiveWorkspace,
} from "@agentproto/runtime/workspaces-config"

const USAGE = `agentproto sessions — browse local daemon sessions

Usage:
  agentproto sessions [--watch] [--json]
  agentproto sessions --attach <id> [--no-color]

Discovers the daemon via ~/.agentproto/runtime.json. Set
AGENTPROTO_DAEMON_URL to override.
`

interface SessionDescriptor {
  id: string
  kind: string
  workspaceSlug: string
  command: string
  pid: number | null
  status: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  lastOutputAt?: string
  label?: string
}

export async function runSessions(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      watch: { type: "boolean" },
      json: { type: "boolean" },
      attach: { type: "string" },
      "no-color": { type: "boolean" },
    },
  })

  const baseUrl = await resolveDaemonUrl()
  if (!baseUrl) {
    process.stderr.write(
      "agentproto sessions: no daemon found.\n" +
        "  Start one with `agentproto serve` or set AGENTPROTO_DAEMON_URL.\n"
    )
    return 2
  }

  if (values.attach) {
    return runAttach({
      baseUrl,
      id: values.attach,
      colour: !values["no-color"],
    })
  }

  if (values.json) {
    const list = await fetchSessions(baseUrl)
    process.stdout.write(JSON.stringify(list, null, 2) + "\n")
    return 0
  }

  if (values.watch) {
    return runWatch(baseUrl)
  }

  // One-shot
  const list = await fetchSessions(baseUrl)
  printTable(list)
  return 0
}

async function resolveDaemonUrl(): Promise<string | null> {
  if (process.env.AGENTPROTO_DAEMON_URL) {
    return process.env.AGENTPROTO_DAEMON_URL.replace(/\/+$/, "")
  }
  // Daemon writes its runtime.json INSIDE the workspace dir (not in
  // ~/.agentproto). We use ~/.agentproto/workspaces.json to find the
  // active workspace, then read its runtime.json. Falls back to
  // probing each registered workspace if active doesn't have a live
  // runtime.json (the user can have multiple workspaces with daemons
  // in/out of running state).
  const config = await loadWorkspacesConfig().catch(() => null)
  if (!config) return null
  const candidates = [
    getActiveWorkspace(config),
    ...config.workspaces,
  ].filter(
    (w, i, arr): w is NonNullable<typeof w> =>
      !!w && arr.findIndex(x => x?.slug === w.slug) === i
  )
  for (const w of candidates) {
    const url = await readRuntimeJson(w.path)
    if (url) return url
  }
  return null
}

async function readRuntimeJson(workspacePath: string): Promise<string | null> {
  const path = resolve(workspacePath, ".agentproto", "runtime.json")
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as {
      port?: number
      bind?: string
    }
    if (typeof parsed.port !== "number") return null
    return `http://${parsed.bind ?? "127.0.0.1"}:${parsed.port}`
  } catch {
    return null
  }
}

async function fetchSessions(baseUrl: string): Promise<SessionDescriptor[]> {
  const body = await httpGetJson(`${baseUrl}/sessions`)
  if (!body || !Array.isArray((body as { sessions?: unknown }).sessions)) {
    return []
  }
  return (body as { sessions: SessionDescriptor[] }).sessions
}

function printTable(rows: SessionDescriptor[]): void {
  if (rows.length === 0) {
    process.stdout.write("No sessions.\n")
    return
  }
  const widths = {
    id: Math.max(...rows.map(r => r.id.length), 4),
    kind: Math.max(...rows.map(r => r.kind.length), 4),
    workspace: Math.max(...rows.map(r => r.workspaceSlug.length), 9),
    status: Math.max(...rows.map(r => r.status.length), 8),
    age: 8,
  }
  const header =
    pad("ID", widths.id) +
    "  " +
    pad("KIND", widths.kind) +
    "  " +
    pad("WORKSPACE", widths.workspace) +
    "  " +
    pad("STATUS", widths.status) +
    "  " +
    pad("AGE", widths.age) +
    "  COMMAND"
  process.stdout.write(`\x1b[2m${header}\x1b[0m\n`)
  const now = Date.now()
  for (const r of rows) {
    const age = humaniseDelta(now - new Date(r.startedAt).getTime())
    const tone = statusColour(r.status)
    process.stdout.write(
      pad(r.id, widths.id) +
        "  " +
        pad(r.kind, widths.kind) +
        "  " +
        pad(r.workspaceSlug, widths.workspace) +
        "  " +
        `${tone}${pad(r.status, widths.status)}\x1b[0m` +
        "  " +
        pad(age, widths.age) +
        "  " +
        truncate(r.command, 60) +
        "\n"
    )
  }
}

function statusColour(status: string): string {
  switch (status) {
    case "running":
      return "\x1b[32m" // green
    case "starting":
    case "mounting":
      return "\x1b[33m" // yellow
    case "exited":
      return "\x1b[2m" // dim
    case "killed":
    case "error":
      return "\x1b[31m" // red
    default:
      return ""
  }
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s
  return s + " ".repeat(n - s.length)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

function humaniseDelta(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

async function runWatch(baseUrl: string): Promise<number> {
  // Set raw stdin so a single keypress (q) exits without ENTER. Skip
  // raw mode if stdin isn't a TTY (piped); the loop still runs but
  // quitting is via SIGINT instead.
  const tty = process.stdin.isTTY === true
  if (tty) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
  }
  let stop = false
  const onKey = (key: string): void => {
    if (key === "q" || key === "" /* Ctrl-C */) stop = true
  }
  if (tty) process.stdin.on("data", onKey)
  process.on("SIGINT", () => {
    stop = true
  })
  try {
    while (!stop) {
      const list = await fetchSessions(baseUrl).catch(err => {
        process.stdout.write(`\x1bc[fetch error] ${String(err)}\n`)
        return null
      })
      // Clear screen + move cursor home — full repaint each tick.
      process.stdout.write("\x1bc")
      process.stdout.write(
        `\x1b[2magentproto sessions  •  ${baseUrl}  •  ${tty ? "press q to quit" : "Ctrl-C to quit"}\x1b[0m\n\n`
      )
      if (list) printTable(list)
      // Sleep 2s but stay responsive to keypresses
      await new Promise<void>(res => setTimeout(res, 2_000))
    }
  } finally {
    if (tty) {
      process.stdin.off("data", onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdout.write("\n")
  }
  return 0
}

interface AttachOpts {
  baseUrl: string
  id: string
  colour: boolean
}

async function runAttach({ baseUrl, id, colour }: AttachOpts): Promise<number> {
  return new Promise(resolve => {
    const url = new URL(`${baseUrl}/sessions/${id}/stream`)
    const lib = url.protocol === "https:" ? https : http
    const req = lib.get(
      url,
      { headers: { accept: "text/event-stream" } },
      res => {
        if (res.statusCode === 404) {
          process.stderr.write(
            `agentproto sessions --attach: no session "${id}".\n`
          )
          resolve(2)
          return
        }
        if (res.statusCode !== 200) {
          process.stderr.write(
            `agentproto sessions --attach: HTTP ${res.statusCode}\n`
          )
          resolve(1)
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
            for (const line of event.split("\n")) {
              if (line.startsWith("data:")) {
                const payload = line.slice(5).trim()
                try {
                  const json = JSON.parse(payload) as {
                    line?: string
                    stream?: "stdout" | "stderr"
                  }
                  if (typeof json.line !== "string") continue
                  if (colour && json.stream === "stderr") {
                    process.stdout.write(`\x1b[31m${json.line}\x1b[0m\n`)
                  } else {
                    process.stdout.write(json.line + "\n")
                  }
                } catch {
                  // Ignore ill-formed frames silently — daemon may have
                  // sent a comment / heartbeat the parser doesn't model.
                }
              }
            }
            idx = buf.indexOf("\n\n")
          }
        })
        res.on("end", () => resolve(0))
      }
    )
    req.on("error", err => {
      process.stderr.write(`agentproto sessions --attach: ${err.message}\n`)
      resolve(1)
    })
    process.on("SIGINT", () => {
      req.destroy()
      resolve(0)
    })
  })
}

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    lib
      .get(u, res => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", c => (body += c))
        res.on("end", () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
      .on("error", reject)
  })
}
