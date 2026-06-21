/**
 * `agentproto tunnel create --port <n> [--provider quick] [--name <slug>]
 *                            [--label <text>] [--host <host>] [--json]`
 * `agentproto tunnel list [--active] [--json]`
 * `agentproto tunnel stop <id-or-name> [--json]`     (alias: delete, rm)
 * `agentproto tunnel status <id-or-name> [--json]`
 *
 * Manage public tunnels via the daemon's /tunnels HTTP routes.
 * Discovers the daemon via ~/.agentproto/runtime.json (same pattern as
 * `agentproto sessions`).
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
import type { TunnelDescriptor } from "@agentproto/runtime"

const USAGE = `agentproto tunnel — manage public cloudflared tunnels

Usage:
  agentproto tunnel create --port <n> [--provider quick] [--name <slug>]
                           [--label <text>] [--host <host>] [--json]
  agentproto tunnel list   [--active] [--json]
  agentproto tunnel stop   <id-or-name> [--json]       (alias: delete, rm)
  agentproto tunnel status <id-or-name> [--json]

Discovers the daemon via ~/.agentproto/runtime.json. Tunnels are
Cloudflare Quick Tunnels (no API key, ephemeral *.trycloudflare.com URL).

Examples:
  agentproto tunnel create --port 3000
  agentproto tunnel create --port 5173 --name vite-preview --json
  agentproto tunnel list
  agentproto tunnel list --active
  agentproto tunnel stop vite-preview
  agentproto tunnel status vite-preview
`

export async function runTunnel(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "create") return runCreate(args.slice(1))
  if (sub === "list") return runList(args.slice(1))
  if (sub === "stop" || sub === "delete" || sub === "rm") return runStop(args.slice(1))
  if (sub === "status") return runStatus(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto tunnel: unknown subcommand "${sub}"\n` +
      `  Known: create | list | stop | status\n`,
  )
  return 2
}

// ── create ────────────────────────────────────────────────────────────

async function runCreate(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      port: { type: "string" },
      provider: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      host: { type: "string" },
      json: { type: "boolean" },
    },
  })

  if (!values.port) {
    process.stderr.write(
      "agentproto tunnel create: --port is required.\n" +
        "  Try: agentproto tunnel create --port 3000\n",
    )
    return 2
  }
  const targetPort = Number.parseInt(values.port, 10)
  if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
    process.stderr.write(
      `agentproto tunnel create: --port must be 1-65535, got "${values.port}"\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto tunnel create")
    return 2
  }
  const endpoint = report.found

  const body: Record<string, unknown> = { targetPort }
  if (values.provider) body.provider = values.provider
  if (values.name) body.name = values.name
  if (values.label) body.label = values.label
  if (values.host) body.targetHost = values.host

  let desc: TunnelDescriptor
  try {
    desc = await httpPostJson<TunnelDescriptor>(
      `${endpoint.url}/tunnels`,
      body,
      endpoint.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto tunnel create: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    process.stdout.write(
      `tunnel created  id=${desc.id}${desc.name ? `  name=${desc.name}` : ""}\n` +
        `  url    ${desc.publicUrl}\n` +
        `  target ${desc.targetHost}:${desc.targetPort}\n` +
        `  status ${desc.status}\n`,
    )
  }
  return 0
}

// ── list ──────────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      active: { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto tunnel list")
    return 2
  }
  const endpoint = report.found

  const qs = values.active ? "?onlyActive=true" : ""
  let result: { tunnels: TunnelDescriptor[] }
  try {
    result = await httpGetJson<{ tunnels: TunnelDescriptor[] }>(
      `${endpoint.url}/tunnels${qs}`,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto tunnel list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const tunnels = result.tunnels ?? []
  if (values.json) {
    process.stdout.write(JSON.stringify(tunnels, null, 2) + "\n")
    return 0
  }

  if (tunnels.length === 0) {
    process.stdout.write("No tunnels.\n")
    return 0
  }

  const now = Date.now()
  process.stdout.write(
    `${"ID".padEnd(36)}  ${"NAME".padEnd(16)}  ${"STATUS".padEnd(8)}  ${"PORT".padEnd(5)}  ${"AGE".padEnd(6)}  URL\n`,
  )
  for (const t of tunnels) {
    const age = humaniseDelta(now - new Date(t.createdAt).getTime())
    process.stdout.write(
      `${t.id.padEnd(36)}  ${(t.name ?? "").padEnd(16)}  ${t.status.padEnd(8)}  ${String(t.targetPort).padEnd(5)}  ${age.padEnd(6)}  ${t.publicUrl || "—"}\n`,
    )
  }
  return 0
}

// ── stop ──────────────────────────────────────────────────────────────

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
      "agentproto tunnel stop: missing id or name.\n" +
        "  Try: agentproto tunnel stop <id-or-name>  (find ids with `agentproto tunnel list`)\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto tunnel stop")
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpDelete<{ ok: boolean; tunnelId: string }>(
      `${endpoint.url}/tunnels/${encodeURIComponent(id)}`,
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(`tunnel stopped  ${id}\n`)
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto tunnel stop: no tunnel "${id}" — try \`agentproto tunnel list\`\n`)
      return 2
    }
    process.stderr.write(`agentproto tunnel stop: ${msg}\n`)
    return 1
  }
}

// ── status ────────────────────────────────────────────────────────────

async function runStatus(args: readonly string[]): Promise<number> {
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
      "agentproto tunnel status: missing id or name.\n" +
        "  Try: agentproto tunnel status <id-or-name>\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto tunnel status")
    return 2
  }
  const endpoint = report.found

  let desc: TunnelDescriptor
  try {
    desc = await httpGetJson<TunnelDescriptor>(
      `${endpoint.url}/tunnels/${encodeURIComponent(id)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto tunnel status: no tunnel "${id}" — try \`agentproto tunnel list\`\n`)
      return 2
    }
    process.stderr.write(`agentproto tunnel status: ${msg}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    const now = Date.now()
    const age = humaniseDelta(now - new Date(desc.createdAt).getTime())
    process.stdout.write(
      `id       ${desc.id}\n` +
        (desc.name ? `name     ${desc.name}\n` : "") +
        (desc.label ? `label    ${desc.label}\n` : "") +
        `provider ${desc.provider}\n` +
        `target   ${desc.targetHost}:${desc.targetPort}\n` +
        `url      ${desc.publicUrl || "—"}\n` +
        `status   ${desc.status}\n` +
        `pid      ${desc.pid ?? "—"}\n` +
        `created  ${desc.createdAt} (${age} ago)\n` +
        (desc.stoppedAt ? `stopped  ${desc.stoppedAt}\n` : "") +
        (desc.lastError ? `error    ${desc.lastError}\n` : ""),
    )
  }
  return 0
}

// ── daemon discovery (mirrors sessions.ts pattern) ──────────────────

interface DaemonEndpoint {
  url: string
  token?: string
  sourcePath?: string
}

interface DaemonDiscoveryReport {
  found: DaemonEndpoint | null
  stale: Array<{ path: string; pid: number | null; mtime: Date | null }>
}

async function discoverDaemon(): Promise<DaemonDiscoveryReport> {
  if (process.env.AGENTPROTO_DAEMON_URL) {
    const url = process.env.AGENTPROTO_DAEMON_URL.replace(/\/+$/, "")
    let token: string | undefined = process.env.AGENTPROTO_DAEMON_TOKEN
    if (!token) {
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
    return { found: { url, ...(token ? { token } : {}) }, stale: [] }
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
    if (result.endpoint) return { found: result.endpoint, stale }
    if (result.stale) stale.push(result.stale)
  }
  return { found: null, stale }
}

interface RuntimeJsonRead {
  endpoint: DaemonEndpoint | null
  stale?: { path: string; pid: number | null; mtime: Date | null }
}

async function readRuntimeJsonWithStatus(workspacePath: string): Promise<RuntimeJsonRead> {
  const path = resolve(workspacePath, ".agentproto", "runtime.json")
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(path)
  } catch {
    return { endpoint: null }
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
  if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) {
    return {
      endpoint: null,
      stale: { path, pid: parsed.pid ?? null, mtime: stat.mtime ?? null },
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
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true
    return false
  }
}

function printNoDaemonError(report: DaemonDiscoveryReport, verb: string): void {
  const lines: string[] = [
    `${verb}: no daemon found.`,
    `  Start one with \`agentproto serve\` or set AGENTPROTO_DAEMON_URL.`,
  ]
  if (report.stale.length > 0) {
    lines.push(``, `  found ${report.stale.length} stale runtime.json file(s) (PID dead):`)
    for (const s of report.stale) {
      const age = s.mtime ? humaniseDelta(Date.now() - s.mtime.getTime()) : "?"
      lines.push(`    ${s.path}  (pid=${s.pid ?? "?"} · ${age} old)`)
    }
    lines.push(``, `  these confuse discovery — delete them and re-run:`, ...report.stale.map(s => `    rm ${s.path}`))
  }
  process.stderr.write(lines.join("\n") + "\n")
}

// ── HTTP helpers ──────────────────────────────────────────────────────

function httpGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    lib.get(u, res => {
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
    }).on("error", reject)
  })
}

function httpPostJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    const data = JSON.stringify(body)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(data)),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const req = lib.request(u, { method: "POST", headers }, res => {
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
    })
    req.on("error", reject)
    req.write(data)
    req.end()
  })
}

function httpDelete<T>(url: string, token?: string): Promise<T> {
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
          resolve(raw ? (JSON.parse(raw) as T) : ({} as T))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    req.on("error", reject)
    req.end()
  })
}

function humaniseDelta(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}
