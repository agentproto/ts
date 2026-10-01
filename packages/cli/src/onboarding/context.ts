/**
 * The real {@link StepContext}: host primitives plus the existing CLI/runtime
 * helpers each step reuses. Everything wired here is read-only.
 */

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { arch, homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import { loadConfig } from "@agentproto/runtime/config"
import { loadWorkspacesConfig } from "@agentproto/runtime/workspaces-config"
import { fetchLatestCliVersion } from "@agentproto/runtime/release-check"
import { discoverCredentials } from "@agentproto/runtime/credential-discovery"
import { readPairingsSnapshot, readHostsSnapshot } from "@agentproto/runtime"
import { listAuthProfiles } from "@agentproto/auth"
import { probeLoginShellPath } from "../commands/daemon.js"
import { detectAgents, loadInstallState } from "../commands/install-mcp.js"
import { resolveSkillFanOutTargets } from "../commands/install-skill.js"
import { resolveSkillPackDir } from "../commands/skill-install/pack-resolve.js"
import { findInstalledAppDir } from "../app-serve.js"
import { resolveAdapter } from "../registry/resolve.js"
import { npmLatestVersion } from "../registry/freshness.js"
import { resolveProxyDialOptions } from "../util/proxy-dial.js"
import { pathExists } from "../commands/skill-install/shared.js"
import type { ExecFn, StepContext, StepFs, WebSocketProbeResult } from "./types.js"

async function collectNodeModulesRoots(start: string): Promise<string[]> {
  const seen = new Set<string>()
  const roots: string[] = []
  let cur = start
  for (let i = 0; i < 20; i++) {
    if (seen.has(cur)) break
    seen.add(cur)
    const candidate = join(cur, "node_modules")
    if (await pathExists(candidate)) roots.push(candidate)
    const pnpmCandidate = join(cur, "node_modules", ".pnpm", "node_modules")
    if (await pathExists(pnpmCandidate)) roots.push(pnpmCandidate)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return roots
}

const NETWORK_TIMEOUT_MS = 3_000

export const realFs: StepFs = {
  readFile: (path) => fs.readFile(path, "utf8"),
  access: (path, mode) => fs.access(path, mode),
  stat: (path) => fs.stat(path),
  readdir: (path) => fs.readdir(path),
}

/** Spawn a probe, capture its output; resolves `124` on timeout, `127` on
 *  spawn failure — never rejects. */
export const realExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(124)
    }, opts.timeoutMs ?? 5_000)
    child.stdout?.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr?.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    child.once("error", (err) => {
      stderr += err.message
      done(127)
    })
    child.once("exit", (code) => done(code ?? 1))
  })

/** Real `dialWebSocket`: open (and immediately close) a WS to `url`, routed
 *  through a corporate proxy exactly like the daemon's own rendezvous dial —
 *  never rejects. */
function realDialWebSocket(url: string, opts: { timeoutMs?: number } = {}): Promise<WebSocketProbeResult> {
  const { agent, via } = resolveProxyDialOptions(url)
  const timeoutMs = opts.timeoutMs ?? 4_000
  return new Promise(resolve => {
    let settled = false
    const ws = new WebSocket(url, agent ? { agent } : undefined)
    const finish = (result: WebSocketProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.off("open", onOpen)
      ws.off("error", onError)
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    const onOpen = (): void => finish({ ok: true, via })
    const onError = (err: Error): void => finish({ ok: false, via, error: err.message })
    const timer = setTimeout(() => finish({ ok: false, via, error: `timed out after ${timeoutMs}ms` }), timeoutMs)
    ws.once("open", onOpen)
    ws.once("error", onError)
  })
}

export function createStepContext(cliVersion: string): StepContext {
  return {
    fs: realFs,
    exec: realExec,
    fetch: (input, init) => fetch(input, init),
    dialWebSocket: realDialWebSocket,
    env: process.env,
    homedir: homedir(),
    cwd: process.cwd(),
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    uid: process.getuid?.() ?? null,
    cliVersion,
    now: () => Date.now(),
    sources: {
      loadConfig: () => loadConfig(),
      loadWorkspaces: () => loadWorkspacesConfig(),
      latestCliVersion: () => fetchLatestCliVersion({ timeoutMs: NETWORK_TIMEOUT_MS }),
      loginShellPath: () => probeLoginShellPath(),
      resolveAdapterHandle: async (slug) => (await resolveAdapter(slug)).handle,
      listAuthProfiles: () => listAuthProfiles(),
      discoverCredentials: async () => discoverCredentials(),
      detectClients: () => detectAgents(),
      loadMcpInstallState: () => loadInstallState(),
      loadDevices: async () => {
        const pairings = (await readPairingsSnapshot()).map(r => ({
          fingerprint: r.fingerprint,
          name: r.name,
          createdAt: r.createdAt,
          lastSeen: r.lastSeen,
          ...(r.legacy ? { legacy: true as const } : {}),
        }))
        const clientFps = new Set(pairings.map(p => p.fingerprint))
        // This daemon's own host devices (`hosts.json`) merged into the
        // same snapshot: only the dial-liveness fields the devices step
        // needs (probe time + last error) cross into it — never `pairRoot`
        // or public keys. A fingerprint already present as a client pairing
        // is skipped (recorded there first).
        const hosts = (await readHostsSnapshot())
          .filter(h => !h.ended && !clientFps.has(h.fingerprint))
          .map(h => ({
            fingerprint: h.fingerprint,
            name: h.name,
            createdAt: h.createdAt,
            lastSeen: h.lastSeen,
            ...(h.lastProbeAt ? { hostLastProbeAt: h.lastProbeAt } : {}),
            ...(h.lastError ? { hostLastError: h.lastError } : {}),
          }))
        return [...pairings, ...hosts]
      },
      skillTargets: async () => (await resolveSkillFanOutTargets()).targets,
      resolveSkillPackDir: () => resolveSkillPackDir(undefined, { allowFetch: false }),
      latestSkillPackVersion: () => npmLatestVersion("@agentproto/skill-pack-agentproto", NETWORK_TIMEOUT_MS),
      resolveBuiltinAppDir: async (appId: string) => {
        const slug = appId.replace(/^@agentproto\//, "")
        const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()]
        for (const start of starts) {
          for (const root of await collectNodeModulesRoots(start)) {
            const candidate = join(root, "@agentproto", "apps", slug)
            if (await pathExists(candidate)) return candidate
          }
        }
        return null
      },
      appInstalled: (appId: string) => findInstalledAppDir(appId) !== undefined,
    },
  }
}
