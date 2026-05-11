/**
 * Discover MCP servers already configured in the user's local agent
 * tooling — claude-code, cursor, goose, etc. — so the daemon can
 * surface them in the UI without making the user re-enter the same
 * credentials and URLs they already painstakingly configured for
 * one host.
 *
 * v1 is read-only discovery: we report what's there with source
 * attribution. Future v1.1 ships an "import to daemon" verb that
 * proxies the discovered server through the daemon's own /mcp
 * endpoint so every operator (cloud Guilde, local agents) sees a
 * unified set without per-host config drift.
 *
 * Sources scanned (in priority order):
 *   - ~/.claude.json (claude-code) — `mcpServers` top-level + nested
 *     under `projects[<path>].mcpServers`. Most users land here.
 *   - ~/.cursor/mcp.json (cursor) — flat `mcpServers` map.
 *   - ~/.config/goose/config.yaml (goose) — TOML/YAML hybrid; we
 *     only handle the YAML form for now.
 *   - any `.mcp.json` under the user's home that follows the
 *     standard mcpServers shape.
 *
 * Each source contributes 0..N entries. Errors are caught + logged
 * (broken JSON, missing files, permission denied) — partial
 * discovery beats failing the whole listing on one bad file.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { resolve as resolvePath } from "node:path"
import {
  loadWorkspacesConfig,
  type WorkspaceEntry,
} from "./workspaces-config.js"

export interface DiscoveredMcp {
  /** Stable id within (source, scope, name) — for de-dupe and
   *  cross-call identity (UI treat as React key). */
  id: string
  /** Where we found it. Lets the UI render a source badge. */
  source: "claude-code" | "cursor" | "goose" | "workspace"
  /** "global" when the entry sits at the top level of the host's
   *  config; "project:<path>" when it's scoped to a single
   *  workspace. claude-code in particular nests per-project. */
  scope: string
  /** The host's name for the entry (key in the mcpServers map). */
  name: string
  /** Wire transport — `stdio` (command + args) or `http` / `sse` (url). */
  type: "stdio" | "http" | "sse" | "unknown"
  /** stdio entries: argv to spawn. */
  command?: string
  args?: string[]
  /** stdio entries: env injected into the child. */
  env?: Record<string, string>
  /** http/sse entries: target URL. */
  url?: string
  /** http/sse entries: extra headers (Authorization, etc.). */
  headers?: Record<string, string>
  /** Free-form tags from the source config — claude-code's project
   *  scope is the most common. */
  tags?: string[]
  /** Reason field when `type === "unknown"` — surfaces why the
   *  parser couldn't classify the entry (e.g. neither command nor
   *  url present). */
  parseNote?: string
}

export interface DiscoverMcpsOptions {
  /** Override the home dir — handy for tests that pin a tmpdir. */
  home?: string
}

export async function discoverMcps(
  opts: DiscoverMcpsOptions = {}
): Promise<DiscoveredMcp[]> {
  const home = opts.home ?? homedir()
  const out: DiscoveredMcp[] = []
  const errors: string[] = []
  await Promise.all([
    scanClaudeCode(home, out, errors),
    scanCursor(home, out, errors),
    scanGoose(home, out, errors),
    scanRegisteredWorkspaces(out, errors),
  ])
  // De-dupe identical entries that show up in multiple scopes
  // (e.g. user copied a project entry to global) — keep the first
  // occurrence so the source attribution stays meaningful.
  const seen = new Set<string>()
  const dedup: DiscoveredMcp[] = []
  for (const m of out) {
    const key = `${m.source}:${m.scope}:${m.name}`
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(m)
  }
  if (errors.length > 0) {
    // One log line per error — operators can trace which file
    // failed without us bubbling the whole stack into the response.
    for (const e of errors) console.warn(`[mcp-discovery] ${e}`)
  }
  return dedup.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source)
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope)
    return a.name.localeCompare(b.name)
  })
}

interface RawMcpEntry {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** claude-code stores entries either at top-level `mcpServers` OR
 *  per-project under `projects[<absolute-path>].mcpServers`. We
 *  surface both with `scope` set so the UI can group by project. */
async function scanClaudeCode(
  home: string,
  out: DiscoveredMcp[],
  errors: string[]
): Promise<void> {
  const path = resolvePath(home, ".claude.json")
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    errors.push(`claude-code: read ${path} — ${(err as Error).message}`)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    errors.push(`claude-code: JSON parse ${path} — ${(err as Error).message}`)
    return
  }
  if (!parsed || typeof parsed !== "object") return
  const root = parsed as Record<string, unknown>
  const top = root.mcpServers
  if (top && typeof top === "object") {
    pushMcpMap({
      out,
      source: "claude-code",
      scope: "global",
      map: top as Record<string, unknown>,
    })
  }
  const projects = root.projects
  if (projects && typeof projects === "object") {
    for (const [projPath, proj] of Object.entries(
      projects as Record<string, unknown>
    )) {
      if (!proj || typeof proj !== "object") continue
      const projMcps = (proj as Record<string, unknown>).mcpServers
      if (!projMcps || typeof projMcps !== "object") continue
      pushMcpMap({
        out,
        source: "claude-code",
        scope: `project:${projPath}`,
        map: projMcps as Record<string, unknown>,
      })
    }
  }
}

/** cursor uses ~/.cursor/mcp.json (standard mcpServers shape).
 *  Also supports per-workspace `.cursor/mcp.json` but those need
 *  the user's project paths — out of scope for v1. */
async function scanCursor(
  home: string,
  out: DiscoveredMcp[],
  errors: string[]
): Promise<void> {
  const path = resolvePath(home, ".cursor", "mcp.json")
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    errors.push(`cursor: read ${path} — ${(err as Error).message}`)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    errors.push(`cursor: JSON parse ${path} — ${(err as Error).message}`)
    return
  }
  if (!parsed || typeof parsed !== "object") return
  const root = parsed as Record<string, unknown>
  const map = root.mcpServers
  if (map && typeof map === "object") {
    pushMcpMap({
      out,
      source: "cursor",
      scope: "global",
      map: map as Record<string, unknown>,
    })
  }
}

/** goose stores config in ~/.config/goose/config.yaml. The full
 *  parser is non-trivial (yaml + extension manifests); v1 looks for
 *  the simple `extensions:` block with `mcp_servers` declarations
 *  and emits a parseNote so the user knows we found goose but
 *  punted on the details. */
async function scanGoose(
  home: string,
  out: DiscoveredMcp[],
  errors: string[]
): Promise<void> {
  // ~/.config on macOS / Linux; goose hasn't shipped Windows-native yet.
  const path = resolvePath(home, ".config", "goose", "config.yaml")
  try {
    await fs.access(path)
  } catch {
    return
  }
  // We don't ship a yaml parser as a runtime dep — record presence
  // but punt on parsing. The user sees "goose detected — open
  // ~/.config/goose/config.yaml to inspect entries" which is enough
  // signal to drive a v2 enhancement.
  out.push({
    id: "goose:global:_detected",
    source: "goose",
    scope: "global",
    name: "(goose config detected)",
    type: "unknown",
    parseNote:
      "Goose config found but YAML parsing is not yet implemented. " +
      "Open ~/.config/goose/config.yaml to inspect MCP entries.",
  })
}

/**
 * Per-workspace scan — for each registered workspace, look at the
 * common per-project MCP locations (.mcp.json, .cursor/mcp.json,
 * .vscode/mcp.json). Lets the UI surface "the agentik-studio
 * workspace ships its own chrome-devtools MCP" instead of only
 * showing what the user configured globally in claude/cursor.
 */
async function scanRegisteredWorkspaces(
  out: DiscoveredMcp[],
  errors: string[]
): Promise<void> {
  let workspaces: WorkspaceEntry[] = []
  try {
    const cfg = await loadWorkspacesConfig()
    workspaces = cfg.workspaces
  } catch (err) {
    errors.push(`workspaces: load failed — ${(err as Error).message}`)
    return
  }
  // Walk each workspace + each candidate path. We don't recurse —
  // these are conventional top-level files. Errors per-file are
  // collected; one bad file doesn't fail the rest.
  await Promise.all(
    workspaces.map(async ws => {
      const candidates = [
        resolvePath(ws.path, ".mcp.json"),
        resolvePath(ws.path, ".cursor", "mcp.json"),
        resolvePath(ws.path, ".vscode", "mcp.json"),
      ]
      for (const path of candidates) {
        let raw: string
        try {
          raw = await fs.readFile(path, "utf8")
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
          errors.push(
            `workspace ${ws.slug}: read ${path} — ${(err as Error).message}`
          )
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          errors.push(
            `workspace ${ws.slug}: JSON parse ${path} — ${(err as Error).message}`
          )
          continue
        }
        if (!parsed || typeof parsed !== "object") continue
        const map = (parsed as Record<string, unknown>).mcpServers
        if (!map || typeof map !== "object") continue
        pushMcpMap({
          out,
          source: "workspace",
          scope: `workspace:${ws.slug}`,
          map: map as Record<string, unknown>,
        })
      }
    })
  )
}

function pushMcpMap(args: {
  out: DiscoveredMcp[]
  source: DiscoveredMcp["source"]
  scope: string
  map: Record<string, unknown>
}): void {
  for (const [name, raw] of Object.entries(args.map)) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as RawMcpEntry
    const id = `${args.source}:${args.scope}:${name}`
    const declared = typeof entry.type === "string" ? entry.type : null
    const url = typeof entry.url === "string" ? entry.url : undefined
    const command = typeof entry.command === "string" ? entry.command : undefined
    let type: DiscoveredMcp["type"]
    if (declared === "http" || declared === "sse" || declared === "stdio") {
      type = declared
    } else if (url) {
      type = "http"
    } else if (command) {
      type = "stdio"
    } else {
      type = "unknown"
    }
    const m: DiscoveredMcp = {
      id,
      source: args.source,
      scope: args.scope,
      name,
      type,
    }
    if (command !== undefined) m.command = command
    if (Array.isArray(entry.args)) {
      m.args = entry.args.filter((a): a is string => typeof a === "string")
    }
    if (entry.env && typeof entry.env === "object") {
      m.env = stringifyValues(entry.env)
    }
    if (url !== undefined) m.url = url
    if (entry.headers && typeof entry.headers === "object") {
      m.headers = stringifyValues(entry.headers)
    }
    if (type === "unknown") {
      m.parseNote =
        "Entry has neither `command` nor `url` — couldn't classify transport."
    }
    args.out.push(m)
  }
}

function stringifyValues(
  raw: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v
    else if (v != null) out[k] = String(v)
  }
  return out
}
