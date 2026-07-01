/**
 * Shared daemon-discovery and HTTP helpers for the CLI command files.
 *
 * Previously copy-pasted verbatim in browser.ts, tunnel.ts, and sessions.ts.
 * Extracted here so edits propagate to all three surfaces automatically.
 */
import { promises as fs } from "node:fs"
import { resolve } from "node:path"
import http from "node:http"
import https from "node:https"
import {
  loadWorkspacesConfig,
  getActiveWorkspace,
} from "@agentproto/runtime/workspaces-config"
import { readDaemonRegistry } from "@agentproto/runtime"

export interface DaemonEndpoint {
  url: string
  token?: string
  /** Path of the runtime.json the endpoint came from. Undefined when
   *  the endpoint came from env vars. */
  sourcePath?: string
}

export interface DaemonDiscoveryReport {
  /** First live endpoint, if any. */
  found: DaemonEndpoint | null
  /** runtime.json files we walked past because their PID was dead. */
  stale: Array<{ path: string; pid: number | null; mtime: Date | null }>
}

export interface RuntimeJsonRead {
  /** Resolved live endpoint, or null when the file is missing /
   *  malformed / has a dead PID. */
  endpoint: DaemonEndpoint | null
  /** Set when the file exists but the PID is dead — caller can list
   *  this to the user as a cleanup suggestion. */
  stale?: { path: string; pid: number | null; mtime: Date | null }
}

export async function discoverDaemon(): Promise<DaemonDiscoveryReport> {
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
  // Central daemon registry first (~/.agentproto/daemons/<port>.json).
  // This is workspace-independent, so it finds a daemon launched from
  // ANY cwd — including tunnel mode and repo checkouts whose workspace
  // isn't registered in workspaces.json. Entries are newest-first; take
  // the first live one, collecting dead-PID entries as stale.
  const registryStale: DaemonDiscoveryReport["stale"] = []
  for (const entry of await readDaemonRegistry().catch(() => [])) {
    const { meta, path } = entry
    if (typeof meta.port !== "number") continue
    if (typeof meta.pid === "number" && !isPidAlive(meta.pid)) {
      registryStale.push({ path, pid: meta.pid, mtime: entry.mtime })
      continue
    }
    return {
      found: {
        url: `http://${typeof meta.bind === "string" ? meta.bind : "127.0.0.1"}:${meta.port}`,
        sourcePath: path,
        ...(typeof meta.token === "string" ? { token: meta.token } : {}),
      },
      stale: registryStale,
    }
  }
  const config = await loadWorkspacesConfig().catch(() => null)
  if (!config) return { found: null, stale: registryStale }
  const candidates = [
    getActiveWorkspace(config),
    ...config.workspaces,
  ].filter(
    (w, i, arr): w is NonNullable<typeof w> =>
      !!w && arr.findIndex(x => x?.slug === w.slug) === i,
  )
  const stale: DaemonDiscoveryReport["stale"] = [...registryStale]
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

export async function readRuntimeJsonWithStatus(workspacePath: string): Promise<RuntimeJsonRead> {
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

export function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — it just checks for the process'
    // existence. EPERM would mean "exists but you don't own it";
    // treat any non-throw as alive.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true // exists, we just can't signal
    return false // ESRCH (no such process) and anything else → dead
  }
}

/**
 * Pretty-print a "no daemon found" error. When stale runtime.json
 * files exist, list them with their dead pid + age.
 */
export function printNoDaemonError(report: DaemonDiscoveryReport, verb: string): void {
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
      lines.push(`    ${s.path}  (pid=${s.pid ?? "?"} · ${age} old)`)
    }
    lines.push(
      ``,
      `  these confuse discovery — delete them and re-run:`,
      ...report.stale.map(s => `    rm ${s.path}`),
    )
  }
  process.stderr.write(lines.join("\n") + "\n")
}

export function httpPostJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = Buffer.from(JSON.stringify(body), "utf8")
    const lib = u.protocol === "https:" ? https : http
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": payload.byteLength.toString(),
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
    req.write(payload)
    req.end()
  })
}

export function httpGetJson<T = unknown>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    lib
      .get(u, res => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", c => (body += c))
        res.on("end", () => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(body) as T)
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
      .on("error", reject)
  })
}

export function humaniseDelta(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

export function httpDelete<T>(url: string, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    const headers: Record<string, string> = {}
    if (token) headers.authorization = `Bearer ${token}`
    const req = lib.request(u, { method: "DELETE", headers }, res => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", (c: string) => { raw += c })
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
