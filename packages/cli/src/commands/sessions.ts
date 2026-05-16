/**
 * `agentproto sessions [--watch] [--attach <id>] [--json]`
 * `agentproto sessions start <slug> [--cwd <dir>] [--workspace <slug>]
 *                                    [--prompt <text>] [--label <text>]
 *                                    [--attach] [--json]`
 * `agentproto sessions stop <id>`
 *
 * Browse and control the daemon's live sessions (terminals, agent
 * CLIs, custom commands) without leaving the shell:
 *
 *   agentproto sessions                  one-shot table dump
 *   agentproto sessions --watch          re-render every 2s, q to quit
 *   agentproto sessions --attach <id>    SSE-stream a session's output
 *   agentproto sessions start <slug>     POST /sessions/agent to spawn
 *                                        a persistent agent-cli session
 *   agentproto sessions stop <id>        POST /sessions/:id/kill (SIGTERM)
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
import WebSocket from "ws"
import {
  loadWorkspacesConfig,
  getActiveWorkspace,
} from "@agentproto/runtime/workspaces-config"
import {
  RESUME_STRATEGIES,
  hasResumeStrategy,
} from "@agentproto/runtime/resume-strategies"
import type { SessionDescriptor } from "@agentproto/runtime"

const USAGE = `agentproto sessions — browse and control daemon sessions

Usage:
  agentproto sessions [--watch] [--json]
  agentproto sessions --attach <id-or-name> [--no-color]
  agentproto sessions start <adapter> [--cwd <dir>] [--workspace <slug>]
                                      [--prompt <text>] [--label <text>]
                                      [--attach] [--json] [--no-color]
  agentproto sessions terminal -- <argv...> [--cwd <dir>] [--workspace <slug>]
                                            [--name <slug>] [--label <text>]
                                            [--cols <n>] [--rows <n>]
                                            [--attach] [--json] [--no-color]
  agentproto sessions stop <id-or-name> [--json]

Discovers the daemon via ~/.agentproto/runtime.json. The token in that file
is sent as Bearer on mutating routes; set AGENTPROTO_DAEMON_URL +
AGENTPROTO_DAEMON_TOKEN to override.

While attached:
  Ctrl-] q   detach (session keeps running on the daemon)
  Ctrl-C     send to the child (PTY mode) / detach (SSE mode)
`

// SessionDescriptor is imported from @agentproto/runtime — its
// canonical shape covers adapterSlug / adapterSessionId / cwd / argv
// / resumeMetadata, which the resume/restart flow below relies on.
// Keeping a local re-declaration here in the past drifted out of
// sync with the runtime, breaking type-check on every field added.

export async function runSessions(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  // Route `start` / `stop` / `terminal` subverbs before the flag
  // parser — they take positionals the flag parser would reject.
  const sub = args[0]
  if (sub === "start") return runStart(args.slice(1))
  if (sub === "stop") return runStop(args.slice(1))
  if (sub === "terminal") return runTerminal(args.slice(1))
  if (sub === "mirror") return runMirror(args.slice(1))
  if (sub === "restart") return runRestart(args.slice(1))

  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      watch: { type: "boolean" },
      json: { type: "boolean" },
      attach: { type: "string" },
      simple: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions")
    return 2
  }
  const endpoint = report.found

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: values.attach,
      colour: !values["no-color"],
    })
  }

  if (values.json) {
    const list = await fetchSessions(endpoint.url)
    process.stdout.write(JSON.stringify(list, null, 2) + "\n")
    return 0
  }

  if (values.watch) {
    return values.simple
      ? runWatchSimple(endpoint, !values["no-color"])
      : runWatch(endpoint, !values["no-color"])
  }

  // One-shot
  const list = await fetchSessions(endpoint.url)
  printTable(list)
  return 0
}

async function runStart(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      workspace: { type: "string" },
      prompt: { type: "string", short: "p" },
      label: { type: "string" },
      attach: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto sessions start: missing adapter slug.\n" +
        "  Try: agentproto sessions start claude-code --attach\n"
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions start: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions start")
    return 2
  }
  const endpoint = report.found

  const body: Record<string, string> = { adapter: slug }
  if (values.cwd) body.cwd = resolve(values.cwd)
  if (values.workspace) body.workspaceSlug = values.workspace
  if (values.prompt) body.prompt = values.prompt
  if (values.label) body.label = values.label

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
        (await explain401(endpoint, "agentproto sessions start")) + "\n",
      )
    } else {
      process.stderr.write(`agentproto sessions start: ${msg}\n`)
    }
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    process.stdout.write(
      `agentproto sessions start: spawned ${desc.kind} ${desc.id}` +
        ` (${desc.status}) — ${desc.command}\n`
    )
  }

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: desc.id,
      colour: !values["no-color"],
    })
  }
  return 0
}

async function runStop(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions stop: missing session id.\n" +
        "  Try: agentproto sessions stop <id-or-name>  (find ids with `agentproto sessions`)\n"
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions stop: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions stop")
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpPostJson<{ ok: boolean; id: string }>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}/kill`,
      {},
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(
        result.ok
          ? `agentproto sessions stop: SIGTERM sent to ${id}\n`
          : `agentproto sessions stop: ${id} not running\n`
      )
    }
    return result.ok ? 0 : 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions stop")) + "\n",
      )
      return 1
    }
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions stop: no session "${id}".\n`
      )
      return 2
    }
    process.stderr.write(`agentproto sessions stop: ${msg}\n`)
    return 1
  }
}

/**
 * `agentproto sessions terminal -- <argv...>` — spawn a PTY-backed
 * session via POST /sessions/terminal. The `--` separator is the
 * idiomatic way to pass argv that includes flags the verb's own
 * parser would otherwise eat. Without `--`, the first positional is
 * the binary and the rest are arguments.
 */
async function runTerminal(args: readonly string[]): Promise<number> {
  // Split on `--` so users can pass arbitrary argv (including flags
  // that look like the verb's own). Everything after `--` is argv;
  // anything before is verb flags.
  const sepIdx = args.indexOf("--")
  const verbArgs = sepIdx === -1 ? [...args] : args.slice(0, sepIdx)
  const argvFromSeparator = sepIdx === -1 ? [] : args.slice(sepIdx + 1)

  const { values, positionals } = parseArgs({
    args: verbArgs,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      workspace: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      attach: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })

  // argv = positionals before `--` (none allowed) OR everything after `--`.
  // Pre-`--` positionals are rejected: the user almost certainly typed
  //   `agentproto sessions terminal claude`
  // and meant `agentproto sessions terminal -- claude`, but to avoid
  // ambiguity with flags we require the separator.
  if (positionals.length > 0 && argvFromSeparator.length === 0) {
    // Be lenient: if there's only one positional and it doesn't look
    // like a flag, treat it as `--`-prefixed argv. Saves typing for the
    // common case `agentproto sessions terminal bash --attach`.
    // We already consumed verb flags above, so positionals here are
    // the leftovers — safe to use as argv.
    // Fall through.
  }
  const argv =
    argvFromSeparator.length > 0 ? argvFromSeparator : [...positionals]
  if (argv.length === 0) {
    process.stderr.write(
      "agentproto sessions terminal: missing argv.\n" +
        "  Try: agentproto sessions terminal -- bash\n" +
        "       agentproto sessions terminal -- claude --resume <id>\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions terminal")
    return 2
  }
  const endpoint = report.found

  const cols = values.cols ? Number.parseInt(values.cols, 10) : undefined
  const rows = values.rows ? Number.parseInt(values.rows, 10) : undefined
  const body: Record<string, unknown> = {
    argv,
    cols:
      cols && Number.isFinite(cols) && cols > 0
        ? cols
        : process.stdout.columns && process.stdout.columns > 0
          ? process.stdout.columns
          : 80,
    rows:
      rows && Number.isFinite(rows) && rows > 0
        ? rows
        : process.stdout.rows && process.stdout.rows > 0
          ? process.stdout.rows
          : 24,
  }
  if (values.cwd) body.cwd = resolve(values.cwd)
  if (values.workspace) body.workspaceSlug = values.workspace
  if (values.name) body.name = values.name
  if (values.label) body.label = values.label

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/terminal`,
      body,
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions terminal")) + "\n",
      )
    } else {
      process.stderr.write(`agentproto sessions terminal: ${msg}\n`)
    }
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    process.stdout.write(
      `agentproto sessions terminal: spawned ${desc.id}` +
        `${desc.name ? ` (${desc.name})` : ""} — ${desc.command}\n`,
    )
  }

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: desc.id,
      colour: !values["no-color"],
    })
  }
  return 0
}

interface DaemonEndpoint {
  url: string
  token?: string
  /** Path of the runtime.json the endpoint came from. Lets error
   *  messages tell the user which file to inspect when something
   *  looks wrong. Undefined when the endpoint came from env vars. */
  sourcePath?: string
}

interface DaemonDiscoveryReport {
  /** First live endpoint, if any. */
  found: DaemonEndpoint | null
  /** runtime.json files we walked past because their PID was dead. */
  stale: Array<{ path: string; pid: number | null; mtime: Date | null }>
}

async function discoverDaemon(): Promise<DaemonDiscoveryReport> {
  // Env overrides win on URL. The token is OPTIONAL via env: when
  // only the URL is set, we still try to find a matching runtime.json
  // on disk so mutating routes don't 401 just because the user
  // (or `serve --interactive`) forgot to forward the token.
  if (process.env.AGENTPROTO_DAEMON_URL) {
    const url = process.env.AGENTPROTO_DAEMON_URL.replace(/\/+$/, "")
    let token: string | undefined = process.env.AGENTPROTO_DAEMON_TOKEN
    if (!token) {
      // Walk every registered workspace looking for a runtime.json
      // whose url matches — that gives us the matching token without
      // forcing the user to copy it manually.
      const config = await loadWorkspacesConfig().catch(() => null)
      if (config) {
        for (const ws of config.workspaces) {
          const ep = await readRuntimeJsonWithStatus(ws.path)
          if (ep.endpoint && ep.endpoint.url === url && ep.endpoint.token) {
            token = ep.endpoint.token
            break
          }
        }
      }
    }
    return {
      found: { url, ...(token ? { token } : {}) },
      stale: [],
    }
  }
  const config = await loadWorkspacesConfig().catch(() => null)
  if (!config) return { found: null, stale: [] }
  const candidates = [
    getActiveWorkspace(config),
    ...config.workspaces,
  ].filter(
    (w, i, arr): w is NonNullable<typeof w> =>
      !!w && arr.findIndex(x => x?.slug === w.slug) === i,
  )
  const stale: DaemonDiscoveryReport["stale"] = []
  for (const w of candidates) {
    const result = await readRuntimeJsonWithStatus(w.path)
    if (result.endpoint) {
      return { found: result.endpoint, stale }
    }
    if (result.stale) {
      stale.push(result.stale)
    }
  }
  return { found: null, stale }
}

async function resolveDaemon(): Promise<DaemonEndpoint | null> {
  const report = await discoverDaemon()
  return report.found
}

/** @deprecated Kept for callers that only need the URL. */
async function resolveDaemonUrl(): Promise<string | null> {
  const ep = await resolveDaemon()
  return ep ? ep.url : null
}

/**
 * Pretty-print a "no daemon found" error. When stale runtime.json
 * files exist, list them with their dead pid + age — that's the
 * footgun: the user thinks they have no daemon, but stale files
 * make discovery a guessing game. Suggested fix is at the bottom.
 */
function printNoDaemonError(report: DaemonDiscoveryReport, verb: string): void {
  const lines: string[] = [
    `${verb}: no daemon found.`,
    `  Start one with \`agentproto serve\` or set AGENTPROTO_DAEMON_URL.`,
  ]
  if (report.stale.length > 0) {
    lines.push(
      ``,
      `  found ${report.stale.length} stale runtime.json file(s) (PID dead):`,
    )
    for (const s of report.stale) {
      const age = s.mtime ? humaniseDelta(Date.now() - s.mtime.getTime()) : "?"
      lines.push(
        `    ${s.path}  (pid=${s.pid ?? "?"} · ${age} old)`,
      )
    }
    lines.push(
      ``,
      `  these confuse discovery — delete them and re-run:`,
      ...report.stale.map(s => `    rm ${s.path}`),
    )
  }
  process.stderr.write(lines.join("\n") + "\n")
}

async function readRuntimeJson(workspacePath: string): Promise<DaemonEndpoint | null> {
  const out = await readRuntimeJsonWithStatus(workspacePath)
  return out.endpoint
}

interface RuntimeJsonRead {
  /** Resolved live endpoint, or null when the file is missing /
   *  malformed / has a dead PID. */
  endpoint: DaemonEndpoint | null
  /** Set when the file exists but the PID is dead — caller can list
   *  this to the user as a cleanup suggestion. */
  stale?: { path: string; pid: number | null; mtime: Date | null }
}

async function readRuntimeJsonWithStatus(workspacePath: string): Promise<RuntimeJsonRead> {
  const path = resolve(workspacePath, ".agentproto", "runtime.json")
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(path)
  } catch {
    return { endpoint: null } // ENOENT, etc.
  }
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch {
    return { endpoint: null }
  }
  let parsed: { port?: number; bind?: string; token?: string; pid?: number }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { endpoint: null }
  }
  if (typeof parsed.port !== "number") return { endpoint: null }
  // Liveness check — when the daemon dies without graceful shutdown
  // (kill -9, crash, reboot), its runtime.json lingers on disk with
  // a now-stale token. Trusting that token against a freshly-booted
  // daemon (same port, new token) produces a 401 the user can't
  // easily debug. process.kill(pid, 0) returns true when the process
  // exists, throws ESRCH otherwise — costs nothing, fixes the
  // "I have leftover runtime.json files" footgun.
  if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) {
    return {
      endpoint: null,
      stale: {
        path,
        pid: parsed.pid ?? null,
        mtime: stat.mtime ?? null,
      },
    }
  }
  return {
    endpoint: {
      url: `http://${parsed.bind ?? "127.0.0.1"}:${parsed.port}`,
      sourcePath: path,
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
    },
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — it just checks for the process'
    // existence. EPERM would mean "exists but you don't own it",
    // which on a single-user macOS / Linux box won't happen for a
    // user-launched daemon; treat any non-throw as alive.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true // exists, we just can't signal
    return false // ESRCH (no such process) and anything else → dead
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

/**
 * `agentproto sessions --watch` — interactive TUI picker over the
 * daemon's session list. Auto-refreshes every 2 s; key bindings:
 *
 *   ↑/↓ or j/k   move selection
 *   Enter         attach to selected (PTY-aware via runAttach)
 *   K             kill selected (POST /sessions/:id/kill)
 *   d             forget selected (DELETE /sessions/:id; exited only)
 *   r             refresh now
 *   q or Ctrl-C   quit
 *
 * Non-TTY stdin degrades to a one-shot dump (no live keys, no
 * picker), matching the old behaviour for `agentproto sessions`
 * piped into a pager.
 */
/**
 * `--watch --simple` — the original flat-table picker. Kept for
 * piping into a pager / external tool. The new default is the
 * 3-pane dashboard `runWatch`.
 */
async function runWatchSimple(
  endpoint: DaemonEndpoint,
  colour: boolean,
): Promise<number> {
  const tty = process.stdin.isTTY === true
  if (!tty) {
    const list = await fetchSessions(endpoint.url)
    printTable(list)
    return 0
  }

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")

  let stop = false
  let action: "attach" | null = null
  let attachTargetId: string | null = null
  let cursor = 0
  let rows: SessionDescriptor[] = []
  let statusMsg = ""

  const repaint = (): void => {
    process.stdout.write("\x1bc")
    process.stdout.write(
      `\x1b[2magentproto sessions · ${endpoint.url} · ↑/↓ move · Enter attach · K kill · d forget · r refresh · q quit\x1b[0m\n\n`,
    )
    if (statusMsg) {
      process.stdout.write(`\x1b[33m${statusMsg}\x1b[0m\n\n`)
    }
    printPickerTable(rows, cursor)
  }

  const refresh = async (): Promise<void> => {
    try {
      rows = await fetchSessions(endpoint.url)
    } catch (err) {
      statusMsg = `fetch error: ${err instanceof Error ? err.message : String(err)}`
      rows = []
    }
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1)
  }

  const onKey = (key: string): void => {
    // Arrow keys arrive as ESC [ A/B/C/D — match common terminals.
    if (key === "\x1b[A" || key === "k") {
      if (cursor > 0) cursor--
      repaint()
      return
    }
    if (key === "\x1b[B" || key === "j") {
      if (cursor < rows.length - 1) cursor++
      repaint()
      return
    }
    if (key === "\r" || key === "\n") {
      const target = rows[cursor]
      if (target) {
        action = "attach"
        attachTargetId = target.id
        stop = true
      }
      return
    }
    if (key === "K") {
      const target = rows[cursor]
      if (!target) return
      void httpPostJson<{ ok: boolean }>(
        `${endpoint.url}/sessions/${encodeURIComponent(target.id)}/kill`,
        {},
        endpoint.token,
      )
        .then(r => {
          statusMsg = r.ok
            ? `sent SIGTERM to ${target.id}`
            : `${target.id} not running`
          return refresh()
        })
        .catch(err => {
          statusMsg = `kill error: ${err instanceof Error ? err.message : String(err)}`
        })
        .finally(() => repaint())
      return
    }
    if (key === "d") {
      const target = rows[cursor]
      if (!target) return
      if (
        target.status !== "exited" &&
        target.status !== "killed" &&
        target.status !== "error"
      ) {
        statusMsg = `d: ${target.id} still ${target.status} — use K first`
        repaint()
        return
      }
      void httpDelete(
        `${endpoint.url}/sessions/${encodeURIComponent(target.id)}`,
        endpoint.token,
      )
        .then(() => {
          statusMsg = `forgot ${target.id}`
          return refresh()
        })
        .catch(err => {
          statusMsg = `forget error: ${err instanceof Error ? err.message : String(err)}`
        })
        .finally(() => repaint())
      return
    }
    if (key === "r") {
      statusMsg = ""
      void refresh().finally(() => repaint())
      return
    }
    if (key === "q" || key === "" /* Ctrl-C */) {
      stop = true
      return
    }
    void colour // silence unused-var; reserved for future colour toggle
  }

  process.stdin.on("data", onKey)
  const sigintHandler = (): void => {
    stop = true
  }
  process.once("SIGINT", sigintHandler)

  try {
    await refresh()
    repaint()
    while (!stop) {
      await new Promise<void>(res => setTimeout(res, 2_000))
      if (stop) break
      await refresh()
      repaint()
    }
  } finally {
    process.stdin.off("data", onKey)
    process.off("SIGINT", sigintHandler)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write("\n")
  }

  if (action === "attach" && attachTargetId) {
    return runAttach({
      endpoint,
      idOrName: attachTargetId,
      colour,
    })
  }
  return 0
}

/**
 * Same shape as printTable but highlights the cursor row. Lives next
 * to printTable rather than gating it on a flag — the watch picker
 * needs distinct visual treatment that would otherwise add yet more
 * conditionals to the read-only printer.
 */
function printPickerTable(rows: SessionDescriptor[], cursor: number): void {
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
    "  " +
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
  rows.forEach((r, i) => {
    const age = humaniseDelta(now - new Date(r.startedAt).getTime())
    const tone = statusColour(r.status)
    const marker = i === cursor ? "\x1b[7m▸" : " "
    const reset = i === cursor ? "\x1b[0m" : ""
    process.stdout.write(
      `${marker} ` +
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
        reset +
        "\n",
    )
  })
}

/**
 * `agentproto sessions --watch` — 3-pane dashboard:
 *
 *   ┌─ header (gateway · workspace · pty · origins · mode) ────────────┐
 *   │ SESSIONS                       │ DETAIL                          │
 *   │ ▸ name  pty status age         │ id / name / kind / status / …   │
 *   │   …                            │                                 │
 *   │                                │   press Enter to attach         │
 *   ├─ events strip (last 3 from /events SSE) ───────────────────────── │
 *   └─ keys footer ────────────────────────────────────────────────────┘
 *
 * Alt-screen mode so scrollback isn't trashed. Polls /sessions every
 * 2 s; subscribes to /events for the live ticker. Non-TTY stdin →
 * one-shot dump (no live keys), matching --simple.
 */
async function runWatch(
  endpoint: DaemonEndpoint,
  colour: boolean,
): Promise<number> {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (!tty) {
    const list = await fetchSessions(endpoint.url)
    printTable(list)
    return 0
  }
  // Non-colour pass-through: callers can still pipe via --no-color
  // (mostly relevant when tee-ing to a file from a real terminal).
  void colour

  // ─── state ─────────────────────────────────────────────────────
  let stop = false
  let action: "attach" | "mirror" | null = null
  let attachTargetId: string | null = null
  let cursor = 0
  let sessions: SessionDescriptor[] = []
  let recentEvents: { at: string; line: string }[] = []
  let health: {
    workspace?: string
    uptimeMs?: number
  } | null = null
  let statusMsg = ""
  let statusMsgUntil = 0
  // Per-session preview cache (last N lines from /sessions/:id/preview).
  // Populated on selection change + on each refresh tick so the panel
  // updates as new output lands. Capped to selected + last 5 to bound
  // memory on dashboards left open across many sessions.
  const previewCache = new Map<string, string[]>()
  let lastPreviewFetch = 0

  // ─── terminal setup ────────────────────────────────────────────
  const enterAlt = "\x1b[?1049h"
  const exitAlt = "\x1b[?1049l"
  const hideCur = "\x1b[?25l"
  const showCur = "\x1b[?25h"
  process.stdout.write(enterAlt + hideCur)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")

  const restore = (): void => {
    process.stdout.write(showCur + exitAlt)
    try {
      process.stdin.setRawMode(false)
    } catch {
      /* ignore */
    }
    process.stdin.pause()
  }

  // ─── data fetchers ─────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    try {
      sessions = await fetchSessions(endpoint.url)
      if (cursor >= sessions.length) cursor = Math.max(0, sessions.length - 1)
    } catch (err) {
      flash(
        `fetch error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const refreshHealth = async (): Promise<void> => {
    try {
      const body = (await httpGetJson<{
        workspace?: string
        uptimeMs?: number
      }>(`${endpoint.url}/health`))
      health = body
    } catch {
      health = null
    }
  }

  /**
   * Fetch the last N lines of the selected session's ring buffer so
   * the detail pane shows what it was doing. Background — call site
   * doesn't await; render() reads from the cache. Throttled because
   * the dashboard tick already polls every second; we only re-fetch
   * the preview on selection change or every ~3 ticks.
   */
  const refreshPreview = async (id: string): Promise<void> => {
    try {
      const body = await httpGetJson<{
        lines?: string[]
        bytes?: string | null
      }>(`${endpoint.url}/sessions/${encodeURIComponent(id)}/preview?lines=10`)
      const lines: string[] = []
      if (Array.isArray(body.lines) && body.lines.length > 0) {
        lines.push(...body.lines)
      } else if (typeof body.bytes === "string" && body.bytes.length > 0) {
        // PTY session — split the base64-decoded tail into displayable
        // lines. Strip ANSI escapes; the dashboard's table layout
        // would otherwise show garbled cursor moves / colours.
        try {
          const buf = Buffer.from(body.bytes, "base64").toString("utf8")
          const stripped = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
          const split = stripped.split("\n").filter(l => l.length > 0)
          lines.push(...split.slice(-10))
        } catch {
          // ignore decode errors
        }
      }
      previewCache.set(id, lines)
      // Bound cache: keep only entries for currently-visible sessions
      // plus a handful of recent ones.
      if (previewCache.size > 12) {
        const stale = [...previewCache.keys()].slice(0, previewCache.size - 12)
        for (const k of stale) previewCache.delete(k)
      }
    } catch {
      // best-effort; leave whatever was cached
    }
  }

  // ─── events SSE ────────────────────────────────────────────────
  const eventsUrl = new URL(`${endpoint.url}/events`)
  const lib = eventsUrl.protocol === "https:" ? https : http
  const eventsReq = lib.get(
    eventsUrl,
    { headers: { accept: "text/event-stream" } },
    res => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", chunk => {
        buf += chunk
        let idx = buf.indexOf("\n\n")
        while (idx !== -1) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue
            try {
              const payload = JSON.parse(line.slice(5).trim()) as {
                type?: string
                at?: string
                [k: string]: unknown
              }
              const summary = summariseEvent(payload)
              if (summary) {
                recentEvents.push({
                  at: shortTime(payload.at ?? new Date().toISOString()),
                  line: summary,
                })
                if (recentEvents.length > 5) recentEvents.shift()
                render()
              }
            } catch {
              /* ignore malformed frames */
            }
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => void 0)
    },
  )
  eventsReq.on("error", () => void 0)

  // ─── key handling ──────────────────────────────────────────────
  let keyBuf = ""
  const onKey = (raw: Buffer | string): void => {
    keyBuf += typeof raw === "string" ? raw : raw.toString("utf8")
    while (keyBuf.length > 0) {
      // Try to consume a recognised sequence.
      if (keyBuf.startsWith("\x1b[A")) {
        keyBuf = keyBuf.slice(3)
        if (cursor > 0) cursor--
        const t = sessions[cursor]
        if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
        render()
        continue
      }
      if (keyBuf.startsWith("\x1b[B")) {
        keyBuf = keyBuf.slice(3)
        if (cursor < sessions.length - 1) cursor++
        const t = sessions[cursor]
        if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
        render()
        continue
      }
      const ch = keyBuf[0]
      keyBuf = keyBuf.slice(1)
      if (ch === "j") {
        if (cursor < sessions.length - 1) cursor++
        const t = sessions[cursor]
        if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
        render()
      } else if (ch === "k") {
        if (cursor > 0) cursor--
        const t = sessions[cursor]
        if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
        render()
      } else if (ch === "q" || ch === "\x03" /* Ctrl-C */) {
        stop = true
        return
      } else if (ch === "r") {
        flash("refreshing…")
        void Promise.all([refresh(), refreshHealth()]).finally(render)
      } else if (ch === "\r" || ch === "\n") {
        const t = sessions[cursor]
        if (t) {
          action = "attach"
          attachTargetId = t.id
          stop = true
          return
        }
      } else if (ch === "m") {
        // Read-only mirror — safer than full attach because Ctrl-C
        // cleanly exits without needing the Ctrl-] q chord some
        // terminal emulators swallow.
        const t = sessions[cursor]
        if (t) {
          action = "mirror"
          attachTargetId = t.id
          stop = true
          return
        }
      } else if (ch === "R") {
        // Restart: respawn from history without leaving the dashboard.
        // Inline httpPostJson (like K kill) so failures flash inline
        // and a successful restart shows up in the next refresh —
        // never tears down the watch loop or the parent daemon.
        const t = sessions[cursor]
        if (!t) continue
        void restartSessionInline(endpoint, t)
          .then(msg => flash(msg))
          .catch(err =>
            flash(
              `restart error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(() => void refresh().then(render))
      } else if (ch === "K") {
        const t = sessions[cursor]
        if (!t) continue
        void httpPostJson<{ ok: boolean }>(
          `${endpoint.url}/sessions/${encodeURIComponent(t.id)}/kill`,
          {},
          endpoint.token,
        )
          .then(out =>
            flash(out.ok ? `SIGTERM sent to ${t.id}` : `${t.id} not running`),
          )
          .catch(err =>
            flash(
              `kill error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(() => void refresh().then(render))
      } else if (ch === "d") {
        const t = sessions[cursor]
        if (!t) continue
        if (
          t.status !== "exited" &&
          t.status !== "killed" &&
          t.status !== "error"
        ) {
          flash(`d: ${t.id} still ${t.status} — use K first`)
          render()
          continue
        }
        void httpDelete(
          `${endpoint.url}/sessions/${encodeURIComponent(t.id)}`,
          endpoint.token,
        )
          .then(() => {
            flash(`forgot ${t.id}`)
            return refresh()
          })
          .catch(err =>
            flash(
              `forget error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(() => render())
      }
      // Unknown chars silently discarded — TUI stays calm.
    }
  }

  const flash = (msg: string): void => {
    statusMsg = msg
    statusMsgUntil = Date.now() + 3_000
  }

  // ─── render ────────────────────────────────────────────────────
  const c = colour
    ? {
        reset: "\x1b[0m",
        dim: "\x1b[2m",
        bold: "\x1b[1m",
        reverse: "\x1b[7m",
        green: "\x1b[32m",
        amber: "\x1b[33m",
        cyan: "\x1b[36m",
        red: "\x1b[31m",
      }
    : {
        reset: "",
        dim: "",
        bold: "",
        reverse: "",
        green: "",
        amber: "",
        cyan: "",
        red: "",
      }
  const statusTone = (s: string): string =>
    s === "running"
      ? c.green
      : s === "starting"
        ? c.amber
        : s === "killed" || s === "error"
          ? c.red
          : c.dim

  const render = (): void => {
    const cols = process.stdout.columns || 100
    const rows = process.stdout.rows || 30
    // Layout: 1 header, 1 separator, body (rows-5), 1 separator, 1 events, 1 footer.
    const bodyRows = Math.max(5, rows - 5)
    const sidebarWidth = Math.min(48, Math.max(34, Math.floor(cols * 0.4)))
    const detailWidth = cols - sidebarWidth - 1
    const sep = c.dim + "│" + c.reset
    const out: string[] = []

    // Row 1: header. Truncate to fit `cols` so it doesn't wrap and
    // push the rest of the screen down by a row (which manifested as
    // the title appearing to be missing in narrow terminals).
    const home = process.env.HOME ?? ""
    const ws =
      health?.workspace && home && health.workspace.startsWith(home)
        ? "~" + health.workspace.slice(home.length)
        : health?.workspace ?? "?"
    const headerLeft = `${c.bold}agentproto monitor${c.reset} ${c.dim}·${c.reset} ${c.cyan}${endpoint.url}${c.reset}`
    const headerRight = `${c.dim}workspace${c.reset} ${ws} ${c.dim}·${c.reset} ${c.dim}uptime${c.reset} ${humaniseDelta(health?.uptimeMs ?? 0)}`
    out.push(fitRow(headerLeft, headerRight, cols))
    out.push(c.dim + "─".repeat(cols) + c.reset)

    // Sidebar + detail (bodyRows lines). padEndVisible counts ANSI
    // escapes as zero-width so the column separator lands at the
    // sidebarWidth-th visible column, not the sidebarWidth-th
    // string-index (which over-pads when colors are on).
    const sidebarLines = renderSidebar(sessions, cursor, sidebarWidth, bodyRows, c, statusTone)
    const selected = sessions[cursor]
    const preview = selected ? previewCache.get(selected.id) : undefined
    const detailLines = renderDetail(selected, detailWidth, bodyRows, c, preview)
    for (let i = 0; i < bodyRows; i++) {
      out.push(
        padEndVisible(sidebarLines[i] ?? "", sidebarWidth) +
          sep +
          (detailLines[i] ?? ""),
      )
    }
    out.push(c.dim + "─".repeat(cols) + c.reset)

    // Events strip
    const evLine = recentEvents.length === 0
      ? `${c.dim}events  ·  (no events yet)${c.reset}`
      : `${c.dim}events${c.reset}  ` +
        recentEvents
          .map(e => `${c.dim}${e.at}${c.reset} ${e.line}`)
          .join(`  ${c.dim}·${c.reset}  `)
    out.push(truncateAnsi(evLine, cols))

    // Footer
    const showFlash =
      statusMsg && Date.now() < statusMsgUntil
    const selectedDesc = sessions[cursor]
    const isDead =
      selectedDesc &&
      (selectedDesc.status === "exited" ||
        selectedDesc.status === "killed" ||
        selectedDesc.status === "error")
    const footer = showFlash
      ? `${c.amber}${statusMsg}${c.reset}`
      : isDead
        ? `${c.dim}↑/↓ select · ${c.reset}${c.bold}R restart${c.reset}${c.dim} · m mirror · d forget · r refresh · q quit${c.reset}`
        : `${c.dim}↑/↓ select · Enter attach · R restart · m mirror · K kill · d forget · r refresh · q quit${c.reset}`
    out.push(truncateAnsi(footer, cols))

    // Paint: clear + home + write.
    process.stdout.write("\x1b[H\x1b[2J" + out.join("\n"))
  }

  // ─── signals + cleanup ─────────────────────────────────────────
  const onResize = (): void => render()
  process.stdin.on("data", onKey)
  process.stdout.on("resize", onResize)
  const sigintHandler = (): void => {
    stop = true
  }
  process.once("SIGINT", sigintHandler)

  try {
    await Promise.all([refresh(), refreshHealth()])
    // Initial preview for the first session.
    if (sessions[cursor]) void refreshPreview(sessions[cursor]!.id)
    render()
    let ticks = 0
    while (!stop) {
      await new Promise<void>(res => setTimeout(res, 1_000))
      if (stop) break
      ticks++
      // Sessions every 2 s, health every 10 s — health rarely
      // changes after boot, no point hammering it.
      if (ticks % 2 === 0) await refresh()
      if (ticks % 10 === 0) await refreshHealth()
      // Preview every 3 s for the currently-selected session — keep
      // the panel feeling alive without hammering the daemon.
      if (ticks - lastPreviewFetch >= 3) {
        const t = sessions[cursor]
        if (t) void refreshPreview(t.id)
        lastPreviewFetch = ticks
      }
      render()
    }
  } finally {
    eventsReq.destroy()
    process.stdin.off("data", onKey)
    process.stdout.off("resize", onResize)
    process.off("SIGINT", sigintHandler)
    restore()
  }

  if (action === "attach" && attachTargetId) {
    // Run the attach, then re-enter the watch loop so the dashboard
    // doesn't disappear after a detach. The user gets the natural
    // workflow: peek at a session, drive it, detach, see the list
    // again, pick another one — until they hit q.
    const code = await runAttach({
      endpoint,
      idOrName: attachTargetId,
      colour,
    })
    void code
    return runWatch(endpoint, colour)
  }
  if (action === "mirror" && attachTargetId) {
    const code = await runMirror([attachTargetId])
    void code
    return runWatch(endpoint, colour)
  }
  return 0
}

/**
 * Restart a session without exiting the watch loop. Mirrors what
 * `runRestart` does — looks up the descriptor, picks the right
 * route, sends the body — but returns a short status string for
 * the dashboard's flash banner instead of writing to stderr / exit
 * code. Errors propagate so the caller can format the message.
 *
 * For agent-cli sessions we attempt to resume the conversation via
 * the prior adapter session id. Adapters (claude-code, hermes)
 * persist that id only AFTER the first turn — a session killed
 * before it had any conversation reports "Resource not found" on
 * resume. In that case we automatically retry the same shape WITHOUT
 * resumeSessionId so the user at least gets their command back; the
 * banner makes the fallback explicit so they know history was lost.
 */
async function restartSessionInline(
  endpoint: DaemonEndpoint,
  prev: SessionDescriptor,
): Promise<string> {
  const augmented = await augmentWithFsResume(prev)
  const built = buildRestartBody(augmented)
  return executeRestartWithFallback(endpoint, augmented, built)
}

interface RestartBody {
  url: string
  body: Record<string, unknown>
}

/**
 * Generic filesystem-fallback: for each known adapter strategy that
 * defines an `fsProbe`, run it against this session's cwd. If a
 * resume id is found, attach it to the descriptor's resumeMetadata.
 *
 * Lets `restart` recover continuity even when our own output sniffer
 * missed the resume hint (session killed too quickly, output buffered
 * past the kill, …). Eligible only when the file is at-or-after the
 * session's `startedAt` (avoid resuming an unrelated prior session
 * in the same cwd — see ResumeStrategy.fsProbe comment).
 */
/**
 * Describe which resume path was used for a successful restart, so
 * the CLI/dashboard banner can tell the user what happened. Returns
 * a short phrase like "resumed via claude --resume" or "resumed via
 * ACP", or an empty string when no resume was attempted.
 */
function describeResumePath(prev: SessionDescriptor): string {
  if (prev.adapterSlug) {
    const s = RESUME_STRATEGIES[prev.adapterSlug]
    if (s?.spawnArgs && s.storeAs && prev.resumeMetadata?.[s.storeAs]) {
      const sample = s.spawnArgs("…")[0] ?? prev.adapterSlug
      return `resumed via ${sample} --resume`
    }
  }
  if (prev.adapterSlug && prev.adapterSessionId) {
    return "resumed via ACP"
  }
  return ""
}

async function augmentWithFsResume(
  prev: SessionDescriptor,
): Promise<SessionDescriptor> {
  const slug = prev.adapterSlug
  if (!slug) return prev
  const strategy = RESUME_STRATEGIES[slug]
  if (!strategy?.fsProbe) return prev
  // If we already have a captured id for this strategy's storage key,
  // skip the FS probe — the sniffer found it during the session.
  if (prev.resumeMetadata?.[strategy.storeAs]) return prev
  if (!prev.cwd) return prev
  const id = await strategy.fsProbe(prev.cwd, prev.startedAt)
  if (!id) return prev
  return {
    ...prev,
    resumeMetadata: {
      ...(prev.resumeMetadata ?? {}),
      [strategy.storeAs]: id,
    },
  }
}

function buildRestartBody(prev: SessionDescriptor): RestartBody {
  // Provider-native resume takes precedence over ACP-level resume.
  // Look up the adapter's strategy in the central registry; when it
  // defines `spawnArgs` AND we've captured a resume id for it, spawn
  // a PTY running the provider's native resume command. That works
  // whenever the provider persisted the session, regardless of
  // whether the ACP wrapper did — strictly more reliable.
  if (prev.adapterSlug) {
    const strategy = RESUME_STRATEGIES[prev.adapterSlug]
    const id = strategy?.storeAs
      ? prev.resumeMetadata?.[strategy.storeAs]
      : undefined
    if (strategy?.spawnArgs && id) {
      return {
        url: "__pty__",
        body: {
          argv: strategy.spawnArgs(id),
          cwd: prev.cwd ?? undefined,
          workspaceSlug: prev.workspaceSlug,
          cols: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
          ...(prev.name ? { name: prev.name } : {}),
          ...(prev.label ? { label: prev.label } : {}),
        },
      }
    }
  }
  if (prev.pty === true) {
    const argv = Array.isArray(prev.argv)
      ? prev.argv
      : tokenizeCommand(prev.command)
    return {
      url: "__pty__",
      body: {
        argv,
        cwd: prev.cwd ?? undefined,
        workspaceSlug: prev.workspaceSlug,
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        ...(prev.name ? { name: prev.name } : {}),
        ...(prev.label ? { label: prev.label } : {}),
      },
    }
  }
  if (prev.adapterSlug) {
    return {
      url: "__agent__",
      body: {
        adapter: prev.adapterSlug,
        cwd: prev.cwd ?? undefined,
        workspaceSlug: prev.workspaceSlug,
        ...(prev.adapterSessionId
          ? { resumeSessionId: prev.adapterSessionId }
          : {}),
        ...(prev.label ? { label: prev.label } : {}),
      },
    }
  }
  throw new Error(
    `${prev.id} is a generic command session — restart only supports pty + agent-cli`,
  )
}

async function executeRestartWithFallback(
  endpoint: DaemonEndpoint,
  prev: SessionDescriptor,
  built: RestartBody,
): Promise<string> {
  const url =
    built.url === "__pty__"
      ? `${endpoint.url}/sessions/terminal`
      : `${endpoint.url}/sessions/agent`
  try {
    const next = await httpPostJson<SessionDescriptor>(
      url,
      built.body,
      endpoint.token,
    )
    const path = describeResumePath(prev)
    return `restarted ${prev.id} → ${next.id}${
      next.name ? ` (${next.name})` : ""
    }${path ? ` (${path})` : ""}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Adapter doesn't recognize the resume id — typically means the
    // session never got past the spawn (no turn happened). Retry
    // without resume so the user at least gets the command back.
    if (
      built.body.resumeSessionId &&
      /not found|Resource not found/i.test(msg)
    ) {
      const { resumeSessionId, ...rest } = built.body
      void resumeSessionId
      const next = await httpPostJson<SessionDescriptor>(
        url,
        rest,
        endpoint.token,
      )
      return `restarted ${prev.id} → ${next.id}${
        next.name ? ` (${next.name})` : ""
      } (fresh — resume not available)`
    }
    throw err
  }
}

function renderSidebar(
  rows: SessionDescriptor[],
  cursor: number,
  width: number,
  height: number,
  c: Record<string, string>,
  statusTone: (s: string) => string,
): string[] {
  const out: string[] = []
  out.push(`${c.bold}SESSIONS${c.reset} ${c.dim}(${rows.length})${c.reset}`)
  out.push("")
  if (rows.length === 0) {
    out.push(`${c.dim}  (none — spawn one)${c.reset}`)
  } else {
    const now = Date.now()
    for (let i = 0; i < rows.length && out.length < height; i++) {
      const r = rows[i]!
      const selected = i === cursor
      const marker = selected ? `${c.cyan}▸${c.reset}` : " "
      const ptyBadge = r.pty
        ? `${c.green}PTY${c.reset}`
        : `${c.dim}   ${c.reset}`
      const label = r.name ?? r.id
      const tone = statusTone(r.status)
      const age = humaniseDelta(now - new Date(r.startedAt).getTime())
      const labelTrunc = truncate(label, 18)
      const line =
        `${marker} ${ptyBadge} ${labelTrunc.padEnd(18)} ${tone}${r.status.padEnd(7)}${c.reset} ${c.dim}${age.padStart(4)}${c.reset}`
      out.push(selected ? line : line)
    }
  }
  while (out.length < height) out.push("")
  void width
  return out.slice(0, height)
}

function renderDetail(
  s: SessionDescriptor | undefined,
  width: number,
  height: number,
  c: Record<string, string>,
  preview: string[] | undefined,
): string[] {
  const out: string[] = []
  if (!s) {
    out.push(`${c.bold}DETAIL${c.reset}`)
    out.push("")
    out.push(`${c.dim}  no session selected${c.reset}`)
  } else {
    const now = Date.now()
    out.push(`${c.bold}DETAIL${c.reset}`)
    out.push("")
    const kw = (k: string): string => `${c.dim}${k.padEnd(10)}${c.reset}`
    out.push(`  ${kw("id")} ${s.id}`)
    if (s.name) out.push(`  ${kw("name")} ${c.bold}${s.name}${c.reset}`)
    out.push(`  ${kw("kind")} ${s.kind}${s.pty ? ` ${c.green}(pty)${c.reset}` : ""}`)
    out.push(`  ${kw("status")} ${s.status}`)
    out.push(`  ${kw("workspace")} ${s.workspaceSlug}`)
    out.push(`  ${kw("command")} ${c.dim}${truncate(s.command, width - 14)}${c.reset}`)
    out.push(`  ${kw("pid")} ${s.pid ?? "—"}`)
    out.push(`  ${kw("started")} ${humaniseDelta(now - new Date(s.startedAt).getTime())} ago`)
    if (s.lastOutputAt)
      out.push(
        `  ${kw("last out")} ${humaniseDelta(now - new Date(s.lastOutputAt).getTime())} ago`,
      )
    if (s.exitCode !== undefined)
      out.push(`  ${kw("exit code")} ${s.exitCode}`)

    // Resume info — captured ids so the user can verify the
    // continuity machinery actually saw what it needed. claudeResumeId
    // is the most-useful one (provider-native resume); ACP id is the
    // fallback. Both displayed when present.
    if (s.adapterSlug) {
      out.push(`  ${kw("adapter")} ${s.adapterSlug}`)
    }
    if (s.adapterSessionId) {
      out.push(
        `  ${kw("acp id")} ${c.dim}${truncate(s.adapterSessionId, width - 14)}${c.reset}`,
      )
    }
    if (s.resumeMetadata) {
      for (const [k, v] of Object.entries(s.resumeMetadata)) {
        out.push(
          `  ${kw(shortKey(k))} ${c.green}${truncate(String(v), width - 14)}${c.reset}`,
        )
      }
    }

    out.push("")
    if (s.status === "running" || s.status === "starting") {
      out.push(`  ${c.dim}Enter to attach${c.reset}`)
    } else if (
      s.status === "exited" ||
      s.status === "killed" ||
      s.status === "error"
    ) {
      out.push(`  ${c.dim}R to restart${c.reset}`)
    }

    // Preview: last N lines from the session's ring buffer, fetched
    // by the dashboard in the background. Helps the user see what
    // the session was doing without committing to an attach.
    if (preview && preview.length > 0) {
      out.push("")
      out.push(`  ${c.dim}── recent output ──${c.reset}`)
      for (const line of preview) {
        out.push(`  ${c.dim}${truncate(line, width - 4)}${c.reset}`)
      }
    }
  }
  while (out.length < height) out.push("")
  return out.slice(0, height)
}

/** Compact display label for resumeMetadata keys. */
function shortKey(k: string): string {
  // claudeResumeId → "claude id", hermesResumeId → "hermes id", …
  const m = k.match(/^([a-z]+)ResumeId$/i)
  return m ? `${m[1]!.toLowerCase()} id` : k
}

/**
 * Reduce a RuntimeEvent to a one-liner for the events strip. Returns
 * null for events we don't want to surface (heartbeat-error spam,
 * etc).
 */
function summariseEvent(ev: Record<string, unknown>): string | null {
  const type = typeof ev.type === "string" ? ev.type : "?"
  switch (type) {
    case "boot":
      return `boot · ${(ev.workspace as string | undefined)?.split("/").pop() ?? "?"}`
    case "remote-log":
      return `tunnel: ${truncate(String(ev.line ?? ""), 60)}`
    case "session-spawn":
      return `spawn ${ev.id ?? "?"}`
    case "session-exit":
      return `exit ${ev.id ?? "?"} (${ev.exitCode ?? "?"})`
    case "heartbeat-error":
      return `heartbeat error ${truncate(String(ev.error ?? ""), 40)}`
    default:
      return `${type}`
  }
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
  } catch {
    return "??:??:??"
  }
}

/**
 * Build a left/right justified row that NEVER overflows `cols`. When
 * left + right would exceed the width, the right side is dropped
 * first (it's metadata — keep the title). When even the left side
 * is too wide, truncate with `…`. Without this, the row wraps and
 * pushes the rest of the screen down by a line.
 */
function fitRow(left: string, right: string, cols: number): string {
  const leftLen = stripAnsi(left).length
  const rightLen = stripAnsi(right).length
  if (leftLen + 1 + rightLen <= cols) {
    return left + " ".repeat(cols - leftLen - rightLen) + right
  }
  if (leftLen <= cols) {
    return left + " ".repeat(Math.max(0, cols - leftLen))
  }
  return truncateAnsi(left, cols)
}

/**
 * Right-pad a possibly-ANSI-containing string to a target VISIBLE
 * width. Plain `String.prototype.padEnd` counts ANSI escape bytes
 * as visible characters, which pushes the next column right of its
 * intended position by however many bytes of color codes are in the
 * string. This helper counts visible chars only.
 */
function padEndVisible(s: string, width: number): string {
  const visible = stripAnsi(s).length
  if (visible >= width) return s
  return s + " ".repeat(width - visible)
}

function truncateAnsi(s: string, max: number): string {
  // ANSI escapes are zero-width so truncation should account for them.
  // Simple approach: strip, count visible, slice raw to roughly the
  // same prefix. Good enough for header / footer fixed strings.
  const visible = stripAnsi(s).length
  if (visible <= max) return s
  // Pessimistic: just cut to `max` chars; rare case anyway.
  return s.slice(0, max - 1) + "…"
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function httpDelete(url: string, token?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    const headers: Record<string, string> = {}
    if (token) headers.authorization = `Bearer ${token}`
    const req = lib.request(u, { method: "DELETE", headers }, res => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", c => (raw += c))
      res.on("end", () => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${raw.slice(0, 200)}`))
          return
        }
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    req.on("error", reject)
    req.end()
  })
}

interface AttachOpts {
  endpoint: DaemonEndpoint
  /** id or name. We fetch the descriptor first and switch transport
   *  (SSE vs PTY WS) based on `desc.pty`. */
  idOrName: string
  colour: boolean
}

/**
 * `agentproto sessions mirror <id-or-name>` — read-only tail of a
 * PTY session. Unlike `--attach`, this NEVER takes stdin: Ctrl-C
 * exits the mirror process cleanly without affecting the underlying
 * session. Great for peeking at what an agent or a long-running TUI
 * is doing without committing to a full duplex attach (and the
 * Ctrl-] q detach chord some terminals swallow).
 *
 * For non-PTY sessions, falls back to the existing line-based SSE
 * stream (also already read-only).
 */
/**
 * `agentproto sessions restart <id-or-name>` — respawn a session
 * from history. Looks up the descriptor (alive or historical),
 * clones its kind/argv/cwd/workspace/name/label, and starts a fresh
 * instance via the matching route (/sessions/terminal for PTY,
 * /sessions/agent for ACP agents).
 *
 * The new session gets a new id but reuses the original `name`
 * (which the daemon freed when the old session became
 * killed/exited). Output buffers are NOT carried over — we only
 * persist descriptor metadata, not byte streams.
 */
async function runRestart(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      attach: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions restart: missing session id or name.\n" +
        "  Try: agentproto sessions restart claude-tui\n",
    )
    return 2
  }
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions restart")
    return 2
  }
  const endpoint = report.found

  // Fetch the (possibly historical) descriptor.
  let prev: SessionDescriptor
  try {
    prev = await httpGetJson<SessionDescriptor>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions restart: no session "${id}" found in registry or history.\n`,
      )
      return 2
    }
    process.stderr.write(`agentproto sessions restart: ${msg}\n`)
    return 1
  }

  // Augment with provider-fs-derived resume id when our own capture
  // missed it (e.g., the session was killed before printing the
  // resume hint), then build the body.
  prev = await augmentWithFsResume(prev)
  let built: RestartBody
  try {
    built = buildRestartBody(prev)
  } catch (err) {
    process.stderr.write(
      `agentproto sessions restart: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }
  const body = built.body
  const url =
    built.url === "__pty__"
      ? `${endpoint.url}/sessions/terminal`
      : `${endpoint.url}/sessions/agent`

  let next: SessionDescriptor
  let resumeFallback = false
  try {
    next = await httpPostJson<SessionDescriptor>(url, body, endpoint.token)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions restart")) + "\n",
      )
      return 1
    }
    // Adapter doesn't know the resume id — retry without it.
    if (body.resumeSessionId && /not found|Resource not found/i.test(msg)) {
      try {
        const { resumeSessionId: _, ...rest } = body
        void _
        next = await httpPostJson<SessionDescriptor>(
          url,
          rest,
          endpoint.token,
        )
        resumeFallback = true
      } catch (err2) {
        process.stderr.write(
          `agentproto sessions restart: ${err2 instanceof Error ? err2.message : String(err2)}\n`,
        )
        return 1
      }
    } else {
      process.stderr.write(`agentproto sessions restart: ${msg}\n`)
      return 1
    }
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(next, null, 2) + "\n")
  } else {
    const lineage = resumeFallback
      ? "fresh — resume not available"
      : describeResumePath(prev) || "fresh shape"
    process.stdout.write(
      `agentproto sessions restart: spawned ${next.id}` +
        `${next.name ? ` (${next.name})` : ""} — ${next.command}\n` +
        `  (${lineage} from ${prev.id})\n`,
    )
  }

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: next.id,
      colour: !values["no-color"],
    })
  }
  return 0
}

/**
 * Shell-style argv tokenizer for legacy descriptors that don't carry
 * `argv` separately. Same rules as the spawn-dialog tokenizer in the
 * web app: whitespace splits, single + double quotes group.
 */
function tokenizeCommand(s: string): string[] {
  const out: string[] = []
  let buf = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(ch ?? "")) {
      if (buf) {
        out.push(buf)
        buf = ""
      }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

async function runMirror(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { "no-color": { type: "boolean" } },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions mirror: missing session id or name.\n" +
        "  Try: agentproto sessions mirror claude-tui\n",
    )
    return 2
  }
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions mirror")
    return 2
  }
  const endpoint = report.found
  let desc: SessionDescriptor
  try {
    desc = await httpGetJson<SessionDescriptor>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions mirror: no session "${id}".\n`,
      )
      return 2
    }
    process.stderr.write(`agentproto sessions mirror: ${msg}\n`)
    return 1
  }
  // Pre-attach status check — the underlying PTY process is gone for
  // exited/killed/error sessions; the WS upgrade would only return a
  // confusing close 1011 mid-stream. Tell the user what happened and
  // point at restart.
  if (
    desc.pty === true &&
    (desc.status === "exited" ||
      desc.status === "killed" ||
      desc.status === "error")
  ) {
    printDeadSessionHint("agentproto sessions mirror", desc)
    return 2
  }
  if (desc.pty === true) {
    return runPtyMirror(endpoint, desc)
  }
  // SSE stream is already read-only — same shape as --attach for
  // non-PTY sessions. Reuse it directly so `mirror` is symmetric.
  return runSseAttach(endpoint, desc, !values["no-color"])
}

/**
 * Read-only WS attach to a PTY session. Bytes flow ONLY from daemon
 * → stdout. stdin stays in the user's normal shell state — Ctrl-C
 * triggers SIGINT to this Node process, which exits cleanly without
 * touching the underlying PTY (the daemon-side handle.detach() runs
 * on WS close, leaving the session alive for other attachers).
 */
async function runPtyMirror(
  endpoint: DaemonEndpoint,
  desc: SessionDescriptor,
): Promise<number> {
  return new Promise(done => {
    const initialCols = process.stdout.columns ?? 80
    const initialRows = process.stdout.rows ?? 24
    const wsUrl = `${endpoint.url.replace(/^http/, "ws")}/sessions/${desc.id}/pty?cols=${initialCols}&rows=${initialRows}`
    const ws = new WebSocket(wsUrl, {
      headers: endpoint.token
        ? { authorization: `Bearer ${endpoint.token}` }
        : {},
    })

    process.stderr.write(
      `\x1b[2m─ mirroring ${desc.id}${desc.name ? ` (${desc.name})` : ""} · read-only · Ctrl-C to exit ·\x1b[0m\n`,
    )

    let closed = false
    const close = (code: number): void => {
      if (closed) return
      closed = true
      try {
        ws.close(1000, "client mirror end")
      } catch {
        // ignore
      }
      done(code)
    }

    ws.on("message", raw => {
      let frame: unknown
      try {
        frame = JSON.parse(raw.toString("utf8"))
      } catch {
        return
      }
      if (!frame || typeof frame !== "object") return
      const f = frame as Record<string, unknown>
      if (f.kind === "data" && typeof f.b64 === "string") {
        try {
          process.stdout.write(Buffer.from(f.b64, "base64"))
        } catch {
          /* ignore */
        }
      } else if (f.kind === "exit") {
        const code = typeof f.exitCode === "number" ? f.exitCode : 0
        process.stderr.write(
          `\n\x1b[2m─ session ${desc.id} exited (code ${code}) ·\x1b[0m\n`,
        )
        close(code)
      }
    })
    ws.on("error", err => {
      process.stderr.write(`agentproto sessions mirror: ${err.message}\n`)
      close(1)
    })
    ws.on("close", () => close(0))
    process.on("SIGINT", () => {
      process.stderr.write(
        `\n\x1b[2m─ mirror ended · session still running on daemon ·\x1b[0m\n`,
      )
      close(0)
    })
  })
}

async function runAttach(opts: AttachOpts): Promise<number> {
  // Fetch the descriptor first. The daemon's GET handler resolves
  // id-or-name (see findByIdOrName in sessions.ts), so a typo
  // surfaces as a clean 404 here rather than mid-stream silence.
  let desc: SessionDescriptor
  try {
    desc = await httpGetJson<SessionDescriptor>(
      `${opts.endpoint.url}/sessions/${encodeURIComponent(opts.idOrName)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions --attach: no session "${opts.idOrName}".\n`,
      )
      return 2
    }
    process.stderr.write(`agentproto sessions --attach: ${msg}\n`)
    return 1
  }
  if (
    desc.status === "exited" ||
    desc.status === "killed" ||
    desc.status === "error"
  ) {
    printDeadSessionHint("agentproto sessions --attach", desc)
    return 2
  }
  if (desc.pty === true) {
    return runPtyAttach(opts.endpoint, desc, opts.colour)
  }
  return runSseAttach(opts.endpoint, desc, opts.colour)
}

/**
 * Pretty error for attach attempts against a dead session. Surfaces
 * the status + age + the exact restart command. Saves the user from
 * the cryptic "close 1011 — session not attachable" they'd otherwise
 * see when the WS upgrade fails mid-flight.
 */
function printDeadSessionHint(
  verb: string,
  desc: SessionDescriptor,
): void {
  const handle = desc.name ?? desc.id
  const exitInfo =
    typeof desc.exitCode === "number" ? ` exit ${desc.exitCode}` : ""
  const age = desc.endedAt
    ? humaniseDelta(Date.now() - new Date(desc.endedAt).getTime()) + " ago"
    : "previously"
  process.stderr.write(
    `${verb}: session ${desc.id}${desc.name ? ` (${desc.name})` : ""} ` +
      `is \x1b[31m${desc.status}\x1b[0m (${age}${exitInfo}).\n` +
      `  Spawn a fresh instance with the same shape:\n` +
      `    agentproto sessions restart ${handle}\n` +
      `  Or look at its descriptor only:\n` +
      `    agentproto sessions   # see all\n`,
  )
}

async function runSseAttach(
  endpoint: DaemonEndpoint,
  desc: SessionDescriptor,
  colour: boolean,
): Promise<number> {
  return new Promise(done => {
    const url = new URL(`${endpoint.url}/sessions/${desc.id}/stream`)
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`
    process.stderr.write(
      `\x1b[2m─ attached to ${desc.id}${desc.name ? ` (${desc.name})` : ""} · Ctrl-C to detach ·\x1b[0m\n`,
    )
    const req = lib.get(url, { headers }, res => {
      if (res.statusCode === 404) {
        process.stderr.write(
          `agentproto sessions --attach: no session "${desc.id}".\n`,
        )
        done(2)
        return
      }
      if (res.statusCode !== 200) {
        process.stderr.write(
          `agentproto sessions --attach: HTTP ${res.statusCode}\n`,
        )
        done(1)
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
      res.on("end", () => done(0))
    })
    req.on("error", err => {
      process.stderr.write(`agentproto sessions --attach: ${err.message}\n`)
      done(1)
    })
    process.on("SIGINT", () => {
      req.destroy()
      done(0)
    })
  })
}

/**
 * PTY attach via the daemon's `/sessions/:id/pty` WebSocket. Sets the
 * caller's stdin to raw mode so every keystroke flows to the child
 * verbatim (including Ctrl-C → SIGINT in the PTY). Detach chord:
 *   Ctrl-]  q   close the WS, restore terminal modes, exit code 0
 * Without the chord the session stays alive on the daemon when the
 * process exits / closes. Resize is bridged via SIGWINCH.
 */
async function runPtyAttach(
  endpoint: DaemonEndpoint,
  desc: SessionDescriptor,
  _colour: boolean,
): Promise<number> {
  return new Promise(done => {
    const stdoutTty = process.stdout.isTTY === true
    const stdinTty = process.stdin.isTTY === true
    const initialCols =
      stdoutTty && process.stdout.columns ? process.stdout.columns : 80
    const initialRows =
      stdoutTty && process.stdout.rows ? process.stdout.rows : 24
    const wsUrl = `${endpoint.url.replace(/^http/, "ws")}/sessions/${desc.id}/pty?cols=${initialCols}&rows=${initialRows}`

    // Reconnect policy. close 1006 ("abnormal closure" — the daemon
    // process vanished mid-WS) triggers up to 5 retries with
    // 1s/2s/4s/4s/4s backoff. close 1000 (clean), 4xxx (app-level),
    // and 410/etc on initial handshake all exit immediately. The user
    // gets "── reconnecting (n/5)…" while we try; on success the
    // daemon replays its ring buffer so they see what they missed.
    const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 4_000, 4_000]
    let attempt = 0
    // The active WebSocket — re-pointed on each reconnect so the
    // stdin handler (registered once below) always sends to the
    // current connection.
    let ws: WebSocket = new WebSocket(wsUrl, {
      headers: endpoint.token
        ? { authorization: `Bearer ${endpoint.token}` }
        : {},
    })

    let armed = false
    // Triple-Ctrl-C detach: AZERTY-friendly alternative to Ctrl-] q
    // that doesn't conflict with Claude's own "press Ctrl-C again to
    // exit" UX. Claude exits on the 2nd Ctrl-C → child gone → WS
    // closes naturally. For non-Claude TUIs (bash, vim, htop, …)
    // three Ctrl-Cs in 1s is a deliberate signal we use to detach
    // without taking the child down; the extras forwarded to the
    // child are no-ops in those shells.
    const TRIPLE_CTRLC_WINDOW_MS = 1_000
    const ctrlCTimestamps: number[] = []
    let exitCode = 0
    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      if (stdinTty) {
        try {
          process.stdin.setRawMode(false)
        } catch {
          // ignore
        }
        process.stdin.pause()
      }
      process.stdin.off("data", onStdin)
      process.stdout.off("resize", onResize)
      process.off("SIGWINCH", onResize)
    }

    const onStdin = (raw: Buffer | string): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      // stdin's encoding mode may have been left in "utf8" by a prior
      // helper (printPickerTable, runWatch, …). Coerce to Buffer at
      // the boundary so byte-comparisons in the detach-chord scan are
      // reliable AND multi-byte chars survive base64 round-trip
      // (sending each byte as its own frame would split a 2-byte é).
      const chunk = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw

      // Triple-Ctrl-C detach. Track the last few Ctrl-C timestamps;
      // when three of them fall inside TRIPLE_CTRLC_WINDOW_MS we
      // detach. Each individual Ctrl-C is ALSO forwarded to the
      // child so the user's normal interrupt UX is preserved —
      // Claude's "press Ctrl-C again to exit" still works (it
      // happens on the 2nd press; the 3rd never fires because the
      // child is already gone, no detach is triggered there).
      if (chunk.length === 1 && chunk[0] === 0x03) {
        const now = Date.now()
        ctrlCTimestamps.push(now)
        // Keep only timestamps inside the window.
        while (
          ctrlCTimestamps.length > 0 &&
          now - ctrlCTimestamps[0]! > TRIPLE_CTRLC_WINDOW_MS
        ) {
          ctrlCTimestamps.shift()
        }
        if (ctrlCTimestamps.length >= 3) {
          ctrlCTimestamps.length = 0
          try {
            ws.close(1000, "client detach (triple-ctrlc)")
          } catch {
            // ignore
          }
          return
        }
        // Fall through to forward this Ctrl-C to the child.
      }

      // Detach chord scan: Ctrl-] (0x1d) then q/Q. Either part of the
      // chord may straddle two stdin chunks, so we keep `armed` across
      // invocations.
      let scan = chunk
      if (armed) {
        // Previous chunk ended with 0x1d. If THIS chunk starts with
        // q/Q, detach; otherwise emit the held 0x1d and the new bytes.
        const first = scan[0]
        if (first === 0x71 || first === 0x51) {
          armed = false
          try {
            ws.close(1000, "client detach")
          } catch {
            // ignore
          }
          return
        }
        // Not the chord — flush the held 0x1d as a leading byte by
        // prepending it before further processing.
        scan = Buffer.concat([Buffer.from([0x1d]), scan])
        armed = false
      }

      // Look for an in-chunk 0x1d. If found at the LAST position, hold
      // it for the next stdin event (it might pair with q/Q). If found
      // mid-chunk, check the very next byte — q/Q → detach, else let
      // both through.
      const idx = scan.indexOf(0x1d)
      if (idx === -1) {
        ws.send(JSON.stringify({ kind: "input", b64: scan.toString("base64") }))
        return
      }
      if (idx === scan.length - 1) {
        // Trailing 0x1d — defer.
        armed = true
        const head = scan.subarray(0, idx)
        if (head.length > 0) {
          ws.send(JSON.stringify({ kind: "input", b64: head.toString("base64") }))
        }
        return
      }
      const next = scan[idx + 1]
      if (next === 0x71 || next === 0x51) {
        // Detach mid-chunk. Send the head (bytes before 0x1d), drop
        // both chord bytes, then close. Anything after the chord is
        // discarded — typing past the detach chord is a user error.
        const head = scan.subarray(0, idx)
        if (head.length > 0) {
          ws.send(JSON.stringify({ kind: "input", b64: head.toString("base64") }))
        }
        try {
          ws.close(1000, "client detach")
        } catch {
          // ignore
        }
        return
      }
      // 0x1d followed by something other than q/Q — emit the whole
      // chunk as-is (the 0x1d may legitimately be Ctrl-] -> some app
      // command, e.g. less's prefix). The remote pty figures it out.
      ws.send(JSON.stringify({ kind: "input", b64: scan.toString("base64") }))
    }

    const onResize = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      const cols =
        stdoutTty && process.stdout.columns ? process.stdout.columns : 80
      const rows = stdoutTty && process.stdout.rows ? process.stdout.rows : 24
      ws.send(JSON.stringify({ kind: "resize", cols, rows }))
    }

    let inputWired = false
    let sessionExited = false

    const wireWs = (sock: WebSocket): void => {
      sock.on("open", () => {
        if (attempt === 0) {
          process.stderr.write(
            `\x1b[2m─\x1b[0m attached to \x1b[1m${desc.id}${desc.name ? ` (${desc.name})` : ""}\x1b[0m · ` +
              `\x1b[7m triple Ctrl-C \x1b[0m or \x1b[7m Ctrl-] then q \x1b[0m to detach · ` +
              `Ctrl-C reaches the child (works with Claude's exit)\n`,
          )
        } else {
          process.stderr.write(
            `\x1b[32m─ reconnected to ${desc.id} (attempt ${attempt + 1})\x1b[0m\n`,
          )
        }
        attempt = 0
        if (!inputWired) {
          if (stdinTty) {
            try {
              process.stdin.setRawMode(true)
            } catch {
              // ignore
            }
            process.stdin.resume()
          }
          process.stdin.on("data", onStdin)
          process.stdout.on("resize", onResize)
          process.on("SIGWINCH", onResize)
          inputWired = true
        }
        onResize()
      })

      sock.on("message", raw => {
        let frame: unknown
        try {
          frame = JSON.parse(raw.toString("utf8"))
        } catch {
          return
        }
        if (!frame || typeof frame !== "object") return
        const f = frame as Record<string, unknown>
        switch (f.kind) {
          case "data": {
            if (typeof f.b64 === "string") {
              try {
                process.stdout.write(Buffer.from(f.b64, "base64"))
              } catch {
                // ignore
              }
            }
            break
          }
          case "exit": {
            const code = typeof f.exitCode === "number" ? f.exitCode : 0
            process.stderr.write(
              `\n\x1b[2m─ session ${desc.id} exited (code ${code}) ·\x1b[0m\n`,
            )
            exitCode = code
            sessionExited = true
            break
          }
          // pong / unknown — ignore
        }
      })

      sock.on("close", (code: number, reason: Buffer) => {
        // 1000 = clean: either we initiated (detach) or daemon shut
        // us down cleanly. Either way we're done.
        // 1006 = abnormal: daemon process vanished without a close
        // frame. Worth retrying — they may be coming back up.
        // 4xxx / 410 / 401 / etc. = app-level rejection (session
        // exited, auth, etc.) — surfaced before WS upgrade. Done.
        if (sessionExited || code === 1000) {
          restore()
          done(exitCode)
          return
        }
        if (code === 1006 && attempt < RECONNECT_DELAYS_MS.length) {
          const delay = RECONNECT_DELAYS_MS[attempt] ?? 4_000
          attempt++
          process.stderr.write(
            `\x1b[33m─ disconnected (close ${code}) · reconnecting in ${Math.round(delay / 1000)}s (${attempt}/${RECONNECT_DELAYS_MS.length})…\x1b[0m\n`,
          )
          setTimeout(() => {
            ws = new WebSocket(wsUrl, {
              headers: endpoint.token
                ? { authorization: `Bearer ${endpoint.token}` }
                : {},
            })
            wireWs(ws)
          }, delay)
          return
        }
        // Out of retries or unknown close — surface clearly.
        const reasonText = reason && reason.length > 0 ? ` — ${reason.toString("utf8")}` : ""
        process.stderr.write(
          `\n\x1b[31m─ disconnected (close ${code}${reasonText})\x1b[0m\n` +
            `  daemon may be down. Restart it (\`agentproto serve\`) then re-attach:\n` +
            `    agentproto sessions --attach ${desc.name ?? desc.id}\n`,
        )
        restore()
        done(1)
      })

      sock.on("error", () => {
        // Don't write a noisy error line — 'close' will fire next
        // with the actual reason. WS errors during reconnect attempts
        // are expected and we don't want to spam the terminal.
      })
    }

    wireWs(ws)

    process.on("SIGINT", () => {
      // In PTY mode, Ctrl-C SHOULD go to the child. The terminal
      // emulator forwards \x03 directly through stdin. SIGINT here
      // only fires when stdin isn't a TTY — in which case we detach.
      try {
        ws.close(1000, "sigint")
      } catch {
        // ignore
      }
    })
  })
}

/**
 * Probe `<base>/health` to determine whether the daemon at this URL
 * is reachable. Used to disambiguate "no daemon listening" vs
 * "daemon listening but rejected my token" when a mutating call
 * 401s. Times out after 500ms so a hung process doesn't stall the
 * CLI error path.
 */
async function probeDaemonHealth(baseUrl: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    try {
      const u = new URL(`${baseUrl}/health`)
      const lib = u.protocol === "https:" ? https : http
      const req = lib.get(u, { timeout: 500 }, res => {
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300)
        res.resume()
      })
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * Build a clear error message for a sessions_unauthorized response.
 * The 401 from the daemon is almost always one of three things:
 *   1. The token in this runtime.json is stale (daemon restarted).
 *   2. The CLI's Origin doesn't match the daemon's allowlist
 *      (irrelevant from CLI — there's no Origin header — but kept
 *      in the daemon side for browser callers).
 *   3. AGENTPROTO_DAEMON_TOKEN env var is set to a wrong value.
 *
 * We do NOT have the daemon's true token, so we can't auto-recover.
 * Instead we tell the user exactly which file the token came from
 * + how to get the right one.
 */
async function explain401(
  endpoint: DaemonEndpoint,
  verb: string,
): Promise<string> {
  const alive = await probeDaemonHealth(endpoint.url)
  const lines: string[] = [
    `${verb}: 401 sessions_unauthorized from ${endpoint.url}`,
  ]
  if (!alive) {
    lines.push(
      `  the daemon at ${endpoint.url} is NOT reachable (no /health response).`,
      `  the runtime.json may point at a stopped port — try \`agentproto serve\`.`,
    )
    return lines.join("\n")
  }
  // Daemon is alive — definitely a token mismatch.
  if (process.env.AGENTPROTO_DAEMON_TOKEN) {
    lines.push(
      `  daemon /health is reachable. AGENTPROTO_DAEMON_TOKEN is set in your env —`,
      `  it may be from a previous daemon boot. Clear it: \`unset AGENTPROTO_DAEMON_TOKEN\`,`,
      `  or set it to the live token: \`export AGENTPROTO_DAEMON_TOKEN=$(jq -r .token <runtime.json>)\`.`,
    )
  } else if (endpoint.sourcePath) {
    lines.push(
      `  daemon /health is reachable — token mismatch is the cause.`,
      `  this CLI used the token from:`,
      `    ${endpoint.sourcePath}`,
      `  if you have multiple daemons or restarted the daemon since this file was written,`,
      `  that file's token is stale. Restart the live daemon (\`agentproto serve\`) which`,
      `  rewrites its own runtime.json, then re-run.`,
    )
  } else {
    lines.push(
      `  daemon /health is reachable — token mismatch is the cause.`,
      `  unable to identify which file the token came from (env override?).`,
    )
  }
  return lines.join("\n")
}

function httpPostJson<T>(
  url: string,
  body: unknown,
  token?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = Buffer.from(JSON.stringify(body), "utf8")
    const lib = u.protocol === "https:" ? https : http
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": payload.byteLength.toString(),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const req = lib.request(
      u,
      { method: "POST", headers },
      res => {
        let raw = ""
        res.setEncoding("utf8")
        res.on("data", c => (raw += c))
        res.on("end", () => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${raw.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(raw) as T)
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      }
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

async function httpGetJson<T = unknown>(url: string): Promise<T> {
  return (await httpGetJsonImpl(url)) as T
}

function httpGetJsonImpl(url: string): Promise<unknown> {
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
