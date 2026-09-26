/**
 * mcp-app-resolve — which server config does a session's harness mean by
 * the alias `<server>` in `mcp__<server>__<tool>`?
 *
 * The same alias can name different servers in different projects
 * (`~/.claude.json` `projects[<path>].mcpServers`), so resolution is
 * per session, in this order (first match wins):
 *
 *   1. session  — `SessionDescriptor.mcpServers` entry named `alias`
 *   2. project  — for the session's `cwd`:
 *                 `<cwd>/.mcp.json`,
 *                 `~/.claude.json` `projects[<cwd or nearest ancestor>]`,
 *                 `<cwd>/.codex/config.toml`, `~/.codex/config.toml`
 *   3. user     — `~/.claude.json` top-level `mcpServers`
 *   4. imported — `~/.agentproto/imported-mcps.json` by alias
 *
 * An unreadable or malformed file is skipped, not fatal: a broken
 * `.mcp.json` must not hide the user-scope server of the same name.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve as resolvePath } from "node:path"
import type { AcpMcpServer } from "@agentproto/acp"
import { readCodexMcpServers } from "./codex-config.js"
import type { McpConnectionConfig } from "./mcp-client-pool.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import { parseMcpServerEntry, type DiscoveredMcp } from "./mcp-discovery.js"
import { IMPORTED_MCPS_PATH, loadImportedMcps } from "./mcp-imports.js"

export type McpServerConfigSource = "session" | "project" | "user" | "imported"

export interface ResolvedMcpServer {
  alias: string
  source: McpServerConfigSource
  /** File (or `session:<id>`) the config came from — diagnostics only. */
  origin: string
  config: McpConnectionConfig
}

/** The slice of a session the resolver reads. */
export interface ResolvableSession {
  cwd?: string
  mcpServers?: AcpMcpServer[]
}

export interface ResolveMcpServerOptions {
  /** Home dir for `~/.claude.json` / `~/.codex`. Default `os.homedir()`. */
  home?: string
  /** Default `~/.agentproto/imported-mcps.json`. */
  importedMcpsPath?: string
  /** Brokered headers for a session entry's `credentialRef`. Default: the
   *  daemon's injected `resolveMcpCredentialHeaders` (mcp-credential-deps). */
  resolveCredentialHeaders?: (credentialRef: string) => Promise<Record<string, string> | undefined>
}

export async function resolveMcpServer(
  session: ResolvableSession,
  sessionId: string,
  alias: string,
  opts: ResolveMcpServerOptions = {}
): Promise<ResolvedMcpServer | null> {
  const home = opts.home ?? homedir()

  // 1. The session's own mcpServers.
  const own = session.mcpServers?.find(s => s.name === alias)
  if (own) {
    return {
      alias,
      source: "session",
      origin: `session:${sessionId}`,
      config: await fromAcpMcpServer(own, opts),
    }
  }

  const claudeJsonPath = resolvePath(home, ".claude.json")
  const claudeJson = await readJsonObject(claudeJsonPath)

  // 2. Project scope for the session's cwd.
  if (session.cwd) {
    const cwd = resolvePath(session.cwd)
    const dotMcp = resolvePath(cwd, ".mcp.json")
    const fromDotMcp = pick(mcpServersOf(await readJsonObject(dotMcp)), alias)
    if (fromDotMcp) return found(alias, "project", dotMcp, fromDotMcp)

    const projects = claudeJson?.projects
    if (projects && typeof projects === "object") {
      const projKey = nearestProjectKey(projects as Record<string, unknown>, cwd)
      if (projKey) {
        const proj = (projects as Record<string, unknown>)[projKey]
        const hit = pick(mcpServersOf(proj), alias)
        if (hit) return found(alias, "project", `${claudeJsonPath}#projects[${projKey}]`, hit)
      }
    }

    for (const tomlPath of [
      resolvePath(cwd, ".codex", "config.toml"),
      resolvePath(home, ".codex", "config.toml"),
    ]) {
      const servers = await readCodexMcpServers(tomlPath).catch(() => ({}))
      const hit = pick(servers, alias)
      if (hit) return found(alias, "project", tomlPath, hit)
    }
  }

  // 3. User scope.
  const user = pick(mcpServersOf(claudeJson), alias)
  if (user) return found(alias, "user", claudeJsonPath, user)

  // 4. Imports.
  const importsPath = opts.importedMcpsPath ?? IMPORTED_MCPS_PATH()
  const imports = await loadImportedMcps(importsPath).catch(() => null)
  const imported = imports?.imports.find(e => e.alias === alias)
  if (imported) {
    return {
      alias,
      source: "imported",
      origin: importsPath,
      config: connectionOf(imported.snapshot),
    }
  }
  return null
}

/** `projects` key that is `cwd` itself or its nearest ancestor. */
function nearestProjectKey(projects: Record<string, unknown>, cwd: string): string | null {
  const keys = new Map<string, string>()
  for (const k of Object.keys(projects)) keys.set(resolvePath(k), k)
  let dir = cwd
  for (;;) {
    const hit = keys.get(dir)
    if (hit !== undefined) return hit
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function found(
  alias: string,
  source: McpServerConfigSource,
  origin: string,
  raw: unknown
): ResolvedMcpServer | null {
  // Reuse discovery's entry classifier; its source/scope bookkeeping is
  // irrelevant here — only the connection fields are kept.
  const m = parseMcpServerEntry({ source: "workspace", scope: origin, name: alias, raw })
  if (!m) return null
  return { alias, source, origin, config: connectionOf(m) }
}

function connectionOf(m: DiscoveredMcp): McpConnectionConfig {
  return {
    type: m.type,
    ...(m.command !== undefined ? { command: m.command } : {}),
    ...(m.args !== undefined ? { args: m.args } : {}),
    ...(m.env !== undefined ? { env: m.env } : {}),
    ...(m.url !== undefined ? { url: m.url } : {}),
    ...(m.headers !== undefined ? { headers: m.headers } : {}),
  }
}

/** A session's `AcpMcpServer` — `ref` is the command (stdio) or the url
 *  (http/sse); `credentialRef` resolves through the credential broker the
 *  same way session-spawn does, brokered headers winning on collision. */
async function fromAcpMcpServer(
  s: AcpMcpServer,
  opts: ResolveMcpServerOptions
): Promise<McpConnectionConfig> {
  if (s.transport === "stdio") {
    return {
      type: "stdio",
      ...(s.ref !== undefined ? { command: s.ref } : {}),
      ...(s.args ? { args: s.args } : {}),
      ...(s.env ? { env: s.env } : {}),
    }
  }
  let headers = s.headers ? { ...s.headers } : undefined
  if (s.credentialRef) {
    const resolveHeaders =
      opts.resolveCredentialHeaders ??
      (async (credentialRef: string) =>
        getMcpCredentialDeps().resolveMcpCredentialHeaders?.({ credentialRef }))
    const brokered = await resolveHeaders(s.credentialRef).catch(() => undefined)
    if (brokered) headers = { ...(headers ?? {}), ...brokered }
  }
  return {
    type: s.transport,
    ...(s.ref !== undefined ? { url: s.ref } : {}),
    ...(headers ? { headers } : {}),
  }
}

function pick(map: Record<string, unknown> | undefined, alias: string): unknown {
  if (!map || !Object.prototype.hasOwnProperty.call(map, alias)) return undefined
  return map[alias]
}

function mcpServersOf(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined
  const servers = (v as Record<string, unknown>).mcpServers
  return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : undefined
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
