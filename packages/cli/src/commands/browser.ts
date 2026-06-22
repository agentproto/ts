/**
 * `agentproto browser install <adapter> [--force] [--dry-run]`
 * `agentproto browser start <adapter> [--port N] [--camofox-port N] [--label L] [--non-interactive]`
 * `agentproto browser stop <session-id>`
 * `agentproto browser list [--alive]`
 * `agentproto browser status <session-id>`
 *
 * Manage browser service sessions (Camofox, Bureau, …) registered on
 * the local daemon.
 *
 * `install` runs the adapter's declared config steps interactively and
 * persists the results to `~/.agentproto/browser-adapters/<id>.json`.
 * Subsequent `start` calls read the persisted config automatically via
 * `resolve-launch.ts` in the adapter package.
 *
 * Endpoint discovery: reads `~/.agentproto/runtime.json` written by the
 * daemon at startup. Falls back to `AGENTPROTO_DAEMON_URL` env var.
 * Token from the same file is sent as Bearer on mutating routes.
 *
 * Transport: HTTP, same pattern as `agentproto sessions`. No MCP in the
 * CLI layer — the MCP tools (start_browser, stop_browser, …) are the
 * daemon-side surface; the CLI is just a shell-friendly wrapper over the
 * same HTTP routes.
 *
 * Routes called:
 *   POST /sessions/browser       start (registered in P6 serve.ts)
 *   POST /sessions/:id/kill      stop  (existing generic route)
 *   GET  /sessions               list  (filter kind=browser client-side)
 *   GET  /sessions/:id           status descriptor
 */

import { parseArgs } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionDescriptor } from "@agentproto/runtime"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  httpGetJson,
  humaniseDelta,
} from "./_daemon-helpers.js"
import { getBrowserAdapter } from "@agentproto/adapter-browser"
import { runSteps, loadLedger } from "../lib/setup-prompts.js"
import type { AgentCliSetupStep } from "@agentproto/driver-agent-cli"

const USAGE = `agentproto browser — manage browser service sessions

Usage:
  agentproto browser install <adapter> [--force] [--dry-run] [--only <step>...]
  agentproto browser start <adapter> [--port N] [--camofox-port N] [--label L] [--non-interactive] [--json]
  agentproto browser stop  <session-id>           [--json]
  agentproto browser list  [--alive]              [--json]
  agentproto browser status <session-id>          [--json]

Adapters: camofox (Stealth Firefox headless, :9377)
          bureau  (Camofox + MCP capability server, :8830)
          chromium (Chromium browser service, :3200)

install   Runs the adapter's config prompts and persists the results to
          ~/.agentproto/browser-adapters/<id>.json. Subsequent starts read
          this config automatically — no prompts needed.

Examples:
  agentproto browser install camofox
  agentproto browser install bureau --force
  agentproto browser start camofox
  agentproto browser start bureau --label "my-run"
  agentproto browser start bureau --port 8831 --camofox-port 9378
  agentproto browser list --alive
  agentproto browser status sess_abc12345
  agentproto browser stop sess_abc12345

Discovers the daemon via ~/.agentproto/runtime.json. Set AGENTPROTO_DAEMON_URL
(+ AGENTPROTO_DAEMON_TOKEN) to override.
`

export async function runBrowser(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "install") return runBrowserInstall(args.slice(1))
  if (sub === "start") return runBrowserStart(args.slice(1))
  if (sub === "stop") return runBrowserStop(args.slice(1))
  if (sub === "list") return runBrowserList(args.slice(1))
  if (sub === "status") return runBrowserStatus(args.slice(1))

  process.stderr.write(
    `agentproto browser: missing or unknown sub-command "${sub ?? ""}".\n\n${USAGE}`,
  )
  return 2
}

// ── ledger helpers ────────────────────────────────────────────────────────────

function browserAdapterLedgerPath(adapterId: string): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "browser-adapters", `${adapterId}.json`)
}

function browserAdapterLedgerSlug(adapterId: string): string {
  return `browser-adapter:${adapterId}`
}

// ── sub-commands ─────────────────────────────────────────────────────────────

async function runBrowserInstall(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "boolean", short: "f" },
      "dry-run": { type: "boolean" },
      only: { type: "string", multiple: true },
    },
  })

  const adapterId = positionals[0]
  if (!adapterId) {
    process.stderr.write(
      "agentproto browser install: missing adapter.\n" +
        "  Try: agentproto browser install camofox\n" +
        "       agentproto browser install bureau\n",
    )
    return 2
  }

  const adapter = getBrowserAdapter(adapterId)
  if (!adapter) {
    process.stderr.write(
      `agentproto browser install: unknown adapter "${adapterId}".\n` +
        `  Available: camofox, bureau, chromium\n`,
    )
    return 2
  }

  const steps = (adapter.config ?? []) as AgentCliSetupStep[]
  if (steps.length === 0) {
    process.stdout.write(`agentproto browser install: no config steps for '${adapterId}'.\n`)
    return 0
  }

  const ledgerPath = browserAdapterLedgerPath(adapterId)
  const slug = browserAdapterLedgerSlug(adapterId)

  process.stdout.write(`agentproto browser install: configuring '${adapterId}' (${steps.length} step(s)).\n`)
  const code = await runSteps({
    ledgerPath,
    slug,
    steps,
    force: values.force ?? false,
    dryRun: values["dry-run"] ?? false,
    ...(values.only ? { only: values.only } : {}),
  })

  if (code === 0) {
    process.stdout.write(`agentproto browser install: '${adapterId}' configured. Config saved to ${ledgerPath}\n`)
  }
  return code
}

async function runBrowserStart(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      "camofox-port": { type: "string" },
      label: { type: "string" },
      "non-interactive": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const adapterId = positionals[0]
  if (!adapterId) {
    process.stderr.write(
      "agentproto browser start: missing adapter.\n" +
        "  Try: agentproto browser start camofox\n" +
        "       agentproto browser start bureau\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto browser start: unexpected extra positionals: ${positionals.slice(1).join(" ")}\n`,
    )
    return 2
  }

  // ── Missing config check ─────────────────────────────────────────────────
  // Find config steps that have no ledger entry AND no default (required steps).
  // If any, prompt interactively before sending the start request to the daemon.
  const adapterHandle = getBrowserAdapter(adapterId)
  if (adapterHandle) {
    const ledgerPath = browserAdapterLedgerPath(adapterId)
    const slug = browserAdapterLedgerSlug(adapterId)
    const ledger = await loadLedger(ledgerPath, slug)
    const configSteps = (adapterHandle.config ?? []) as AgentCliSetupStep[]
    const missingStepIds = configSteps
      .filter((s) => s.kind === "prompt" && !ledger.steps[s.id] && !s.default)
      .map((s) => s.id)

    if (missingStepIds.length > 0) {
      if (values["non-interactive"]) {
        process.stderr.write(
          `agentproto browser start: missing required config for '${adapterId}'.\n` +
            `  Run \`agentproto browser install ${adapterId}\` first, or pass these flags:\n` +
            missingStepIds.map((id) => `    --${id}`).join("\n") +
            "\n",
        )
        return 2
      }
      process.stdout.write(
        `agentproto browser start: '${adapterId}' has ${missingStepIds.length} unconfigured step(s) — running prompts.\n`,
      )
      const code = await runSteps({
        ledgerPath,
        slug,
        steps: configSteps,
        only: missingStepIds,
      })
      if (code !== 0) return code
    }
  }

  const adapter = adapterId
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto browser start")
    return 2
  }
  const endpoint = report.found

  const body: Record<string, string | number> = { adapter }
  if (values.port) {
    const p = Number.parseInt(values.port, 10)
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      process.stderr.write(`agentproto browser start: invalid --port "${values.port}"\n`)
      return 2
    }
    body.port = p
  }
  if (values["camofox-port"]) {
    const p = Number.parseInt(values["camofox-port"], 10)
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      process.stderr.write(
        `agentproto browser start: invalid --camofox-port "${values["camofox-port"]}"\n`,
      )
      return 2
    }
    body.camofoxPort = p
  }
  if (values.label) body.label = values.label

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/browser`,
      body,
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        `agentproto browser start: 401 Unauthorized — check that the daemon token in ` +
          `~/.agentproto/runtime.json matches the running daemon.\n`,
      )
    } else {
      process.stderr.write(`agentproto browser start: ${msg}\n`)
    }
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    process.stdout.write(
      `agentproto browser start: registered ${desc.id}` +
        ` (${desc.browserAdapterId ?? adapter}) — ${desc.browserBaseUrl ?? "?"}\n`,
    )
  }
  return 0
}

async function runBrowserStop(args: readonly string[]): Promise<number> {
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
      "agentproto browser stop: missing session id.\n" +
        "  Try: agentproto browser stop <id>  (find ids with `agentproto browser list`)\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto browser stop: unexpected extra positionals: ${positionals.slice(1).join(" ")}\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto browser stop")
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpPostJson<{ ok: boolean; sessionId: string }>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}/kill`,
      {},
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(
        result.ok
          ? `agentproto browser stop: SIGTERM sent to ${id}\n`
          : `agentproto browser stop: ${id} not running\n`,
      )
    }
    return result.ok ? 0 : 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        `agentproto browser stop: 401 Unauthorized — daemon token mismatch.\n`,
      )
      return 1
    }
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto browser stop: no session "${id}".\n`)
      return 2
    }
    process.stderr.write(`agentproto browser stop: ${msg}\n`)
    return 1
  }
}

async function runBrowserList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      alive: { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto browser list")
    return 2
  }
  const endpoint = report.found

  let all: SessionDescriptor[]
  try {
    const body = await httpGetJson<{ sessions?: SessionDescriptor[] }>(
      `${endpoint.url}/sessions`,
    )
    all = Array.isArray(body.sessions) ? body.sessions : []
  } catch (err) {
    process.stderr.write(
      `agentproto browser list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const browsers = all.filter(d => d.kind === "browser")
  const result = values.alive ? browsers.filter(d => d.status === "running") : browsers

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  if (result.length === 0) {
    process.stdout.write(
      values.alive ? "No alive browser sessions.\n" : "No browser sessions.\n",
    )
    return 0
  }

  const widths = {
    id: Math.max(...result.map(r => r.id.length), 4),
    adapter: Math.max(...result.map(r => (r.browserAdapterId ?? "").length), 7),
    status: Math.max(...result.map(r => r.status.length), 6),
    age: 6,
  }
  const header =
    pad("ID", widths.id) +
    "  " +
    pad("ADAPTER", widths.adapter) +
    "  " +
    pad("STATUS", widths.status) +
    "  " +
    pad("AGE", widths.age) +
    "  URL"
  process.stdout.write(`\x1b[2m${header}\x1b[0m\n`)
  const now = Date.now()
  for (const r of result) {
    const age = humaniseDelta(now - new Date(r.startedAt).getTime())
    const tone = statusColour(r.status)
    process.stdout.write(
      pad(r.id, widths.id) +
        "  " +
        pad(r.browserAdapterId ?? "", widths.adapter) +
        "  " +
        `${tone}${pad(r.status, widths.status)}\x1b[0m` +
        "  " +
        pad(age, widths.age) +
        "  " +
        truncate(r.browserBaseUrl ?? "—", 60) +
        "\n",
    )
  }
  return 0
}

async function runBrowserStatus(args: readonly string[]): Promise<number> {
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
      "agentproto browser status: missing session id.\n" +
        "  Try: agentproto browser status <id>  (find ids with `agentproto browser list`)\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto browser status")
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
      process.stderr.write(`agentproto browser status: no session "${id}".\n`)
      return 2
    }
    process.stderr.write(`agentproto browser status: ${msg}\n`)
    return 1
  }

  if (desc.kind !== "browser") {
    process.stderr.write(
      `agentproto browser status: session "${id}" is not a browser session (kind=${desc.kind}).\n`,
    )
    return 1
  }

  // Live health probe — 3 s timeout, best-effort.
  let healthy: boolean | null = null
  let healthBody: unknown = null
  if (desc.browserBaseUrl) {
    const healthUrl = `${desc.browserBaseUrl}/health`
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 3000)
    try {
      const r = await fetch(healthUrl, { signal: ac.signal })
      healthy = r.ok
      if (r.ok) {
        try {
          healthBody = await r.json()
        } catch {
          /* non-JSON health endpoint */
        }
      }
    } catch {
      healthy = false
    } finally {
      clearTimeout(t)
    }
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ descriptor: desc, healthy, healthBody }, null, 2) + "\n")
    return 0
  }

  const now = Date.now()
  const age = humaniseDelta(now - new Date(desc.startedAt).getTime())
  const tone = statusColour(desc.status)
  process.stdout.write(
    `id          ${desc.id}\n` +
      `adapter     ${desc.browserAdapterId ?? "—"}\n` +
      `status      ${tone}${desc.status}\x1b[0m\n` +
      `url         ${desc.browserBaseUrl ?? "—"}\n` +
      `port        ${desc.browserPort ?? "—"}\n` +
      `pid         ${desc.pid ?? "—"}\n` +
      `started     ${age} ago\n` +
      `healthy     ${healthy === null ? "—" : healthy ? "\x1b[32myes\x1b[0m" : "\x1b[31mno\x1b[0m"}` +
      (healthBody ? `  ${JSON.stringify(healthBody)}` : "") +
      "\n",
  )
  return 0
}

// ── display helpers ───────────────────────────────────────────────────────────

function statusColour(status: string): string {
  switch (status) {
    case "running": return "\x1b[32m"
    case "starting": return "\x1b[33m"
    case "exited": return "\x1b[2m"
    case "killed": case "error": return "\x1b[31m"
    default: return ""
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}
