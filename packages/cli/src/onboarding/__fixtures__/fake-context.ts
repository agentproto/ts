/**
 * In-memory {@link StepContext} for onboarding tests. The fake fs also
 * exposes the write-side methods of `fs/promises` so a step that reached
 * past the read-only `StepFs` type would be caught: every call lands in
 * `writes`.
 */

import { dirname } from "node:path"
import { computeDaemonPath } from "../../commands/daemon.js"
import type { ExecResult, StepContext, StepFs, StepSources } from "../types.js"

export const HOME = "/home/tester"

export interface FakeFs extends StepFs {
  files: Map<string, string>
  dirs: Set<string>
  readOnly: Set<string>
  writes: string[]
  writeFile(path: string, data: string): Promise<void>
  mkdir(path: string): Promise<void>
  rm(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
}

export function createFakeFs(files: Record<string, string> = {}, dirs: string[] = []): FakeFs {
  const fileMap = new Map(Object.entries(files))
  const dirSet = new Set(dirs)
  for (const f of fileMap.keys()) {
    for (let d = dirname(f); d !== "/" && !dirSet.has(d); d = dirname(d)) dirSet.add(d)
  }
  const writes: string[] = []
  return {
    files: fileMap,
    dirs: dirSet,
    readOnly: new Set(),
    writes,
    async readFile(path) {
      const v = fileMap.get(path)
      if (v === undefined) throw enoent(path)
      return v
    },
    async access(path, mode) {
      if (!fileMap.has(path) && !dirSet.has(path)) throw enoent(path)
      if (mode !== undefined && mode !== 0 && this.readOnly.has(path)) {
        throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" })
      }
    },
    async stat(path) {
      const isDir = dirSet.has(path)
      if (!isDir && !fileMap.has(path)) throw enoent(path)
      return { isDirectory: () => isDir, isFile: () => !isDir }
    },
    async readdir(path) {
      if (!dirSet.has(path)) throw enoent(path)
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const p of [...fileMap.keys(), ...dirSet]) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0] ?? "")
      }
      return [...names].filter(Boolean)
    },
    async writeFile(path) {
      writes.push(`writeFile ${path}`)
    },
    async mkdir(path) {
      writes.push(`mkdir ${path}`)
    },
    async rm(path) {
      writes.push(`rm ${path}`)
    },
    async rename(from, to) {
      writes.push(`rename ${from} ${to}`)
    },
  }
}

export type ExecHandler = (cmd: string, args: readonly string[]) => ExecResult

/** Sources for a healthy machine: every step comes back `ok`. */
export function healthySources(): StepSources {
  return {
    loadConfig: async () => ({}),
    loadWorkspaces: async () => ({
      version: 1,
      active: "proj",
      workspaces: [{ slug: "proj", path: `${HOME}/proj`, addedAt: "", updatedAt: "" }],
    }),
    latestCliVersion: async () => "1.0.0",
    loginShellPath: async () => "/usr/bin:/bin",
    resolveAdapterHandle: async (slug) => ({
      version_check: { cmd: `probe-${slug}`, parse: "v(\\S+)", range: "*" },
    }),
    listAuthProfiles: async () => [
      { id: "anthropic-cc", endpoint: "anthropic", method: "oauth-bearer", origin: "claude-code" },
    ],
    discoverCredentials: async () => [
      { endpoint: "anthropic", method: "oauth-bearer", origin: "claude-code", hint: "Keychain" },
    ],
    detectClients: async () => [
      { name: "cursor", label: "Cursor", configPath: `${HOME}/.cursor/mcp.json`, hasBinary: false, hasConfig: true },
    ],
    loadMcpInstallState: async () => ({
      entries: [{ agent: "cursor", configPath: `${HOME}/.cursor/mcp.json`, transport: "stdio", registeredAt: "" }],
    }),
    skillTargets: async () => [
      { slug: "claude-code", target: { format: "claude-plugin", unit: "whole-pack", outDir: "~/.claude/plugins/agentproto" } },
      { slug: "hermes", target: { format: "flat-dir", dir: "~/.hermes/skills" } },
    ],
    resolveSkillPackDir: async () => "/pack",
    latestSkillPackVersion: async () => "0.8.3",
  }
}

/** Files matching {@link healthySources}. */
export function healthyFiles(): Record<string, string> {
  return {
    [`${HOME}/.agentproto/config.json`]: "{}",
    [`${HOME}/Library/LaunchAgents/sh.agentproto.plist`]:
      `<key>PATH</key><string>${computeDaemonPath("/usr/bin:/bin")}</string>`,
    [`${HOME}/.cursor/mcp.json`]: JSON.stringify({ mcpServers: { agentproto: { command: "agentproto", args: ["mcp-bridge"] } } }),
    "/pack/.claude-plugin/plugin.json": JSON.stringify({ version: "0.8.3" }),
    "/pack/skills/ap-one/SKILL.md": "---\nname: ap-one\n---",
    "/pack/skills/ap-two/SKILL.md": "---\nname: ap-two\n---",
    [`${HOME}/.claude/plugins/agentproto/.claude-plugin/plugin.json`]: JSON.stringify({ version: "0.8.3" }),
    [`${HOME}/.hermes/skills/ap-one/SKILL.md`]: "x",
    [`${HOME}/.hermes/skills/ap-two/SKILL.md`]: "x",
  }
}

export interface FakeContextOptions {
  fs?: FakeFs
  sources?: Partial<StepSources>
  exec?: ExecHandler
  health?: Record<string, unknown> | null
  platform?: NodeJS.Platform
  nodeVersion?: string
  cwd?: string
  cliVersion?: string
}

export interface FakeContext extends StepContext {
  fs: FakeFs
  execCalls: string[]
}

/** Default exec: every adapter probe reports `claude-code` + `hermes`
 *  installed, the rest absent; `launchctl print` reports a loaded job. */
export const defaultExec: ExecHandler = (cmd, args) => {
  if (cmd === "launchctl") return { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" }
  const script = args[1] ?? ""
  if (script === "probe-claude-code" || script === "probe-hermes") return { code: 0, stdout: "v2.0.0\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "" }
}

export function createFakeContext(opts: FakeContextOptions = {}): FakeContext {
  const fs = opts.fs ?? createFakeFs(healthyFiles())
  const execCalls: string[] = []
  const exec = opts.exec ?? defaultExec
  const health = opts.health === undefined ? { version: "1.0.0", uptimeMs: 65_000, pid: 4242 } : opts.health
  let clock = 0
  return {
    fs,
    execCalls,
    exec: async (cmd, args) => {
      execCalls.push([cmd, ...args].join(" "))
      return exec(cmd, args)
    },
    fetch: async () =>
      health === null
        ? Promise.reject(new Error("ECONNREFUSED"))
        : new Response(JSON.stringify(health), { status: 200, headers: { "content-type": "application/json" } }),
    env: {},
    homedir: HOME,
    cwd: opts.cwd ?? `${HOME}/proj/src`,
    platform: opts.platform ?? "darwin",
    arch: "arm64",
    nodeVersion: opts.nodeVersion ?? "v22.1.0",
    uid: 501,
    cliVersion: opts.cliVersion ?? "1.0.0",
    now: () => (clock += 5),
    sources: { ...healthySources(), ...opts.sources },
  }
}
